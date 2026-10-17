/**
 * Map data slice: the light map features of every plotted borehole and the NOT ON MAP list (both
 * loaded at boot), full records fetched on demand into the boreholes cache, the filter panel and the
 * active result set, and place search (FRONTEND.md F9 to F11; the map UI on top of it is round 2).
 *
 * - On demand: ensureBorehole / ensureDocumentBoreholes fetch through takeBoreholes (pending saves
 *   are respected), one request per uid or document at a time; recordLoads says what the route
 *   screens show meanwhile (LOADING, BOREHOLE NOT FOUND).
 * - Result sets: a filter or an area runs POST /result-sets; the set and its plotted members are
 *   shown together and the id goes into the map URL (?rs=), so a reload or a link restores it.
 * - Place search runs on submit only: one candidate flies there, several are listed in the server's
 *   order (uploaded places first), none says so.
 */
import type { DataSource } from '../data/DataSource';
import { ApiError, errorText, isApiError } from '../data/errors';
import type { Borehole, BoreholeFilter, MapFeature, PlaceCandidate, ResultSet } from '../domain/types';
import { nextNonce, type SliceCreator } from './context';
import type { AppState, MapDataSlice } from './types';

/** The filter panel's reset state: nothing set, unreviewed boreholes included (the review UI shows them). */
export const EMPTY_FILTER: BoreholeFilter = Object.freeze({
  search: null,
  country: null,
  project: null,
  documentId: null,
  minDepth: null,
  maxDepth: null,
  dinCodes: [],
  lithologyMinDepth: null,
  hasSpt: null,
  hasGroundwater: null,
  reviewStatus: [],
  includeUnreviewed: true,
  area: null,
}) as BoreholeFilter;

/** A fresh copy of EMPTY_FILTER (its lists are never shared). */
export const emptyFilter = (): BoreholeFilter => ({ ...EMPTY_FILTER, dinCodes: [], reviewStatus: [] });

/** A copy of a filter whose lists and area are its own (a result set's definition stays as stored). */
const copyFilter = (f: BoreholeFilter): BoreholeFilter => structuredClone(f);

export const NO_PLACE_FOUND = 'No place found';
export const PLACE_SEARCH_UNAVAILABLE = 'Place search unavailable';

type Bbox = [number, number, number, number];

/** True when the point lies inside [min_lon, min_lat, max_lon, max_lat] (a box across the antimeridian too). */
export function insideBbox(p: { lat: number; lng: number }, [minLon, minLat, maxLon, maxLat]: Bbox): boolean {
  if (p.lat < minLat || p.lat > maxLat) return false;
  return minLon <= maxLon ? p.lng >= minLon && p.lng <= maxLon : p.lng >= minLon || p.lng <= maxLon;
}

/** Where to fly for a place: its bbox, else its point as a box of no size. */
export function placeBbox(c: PlaceCandidate): Bbox {
  return c.bbox ?? [c.lng, c.lat, c.lng, c.lat];
}

/**
 * A place is outlined dashed when it holds no uploaded borehole: the server counts none (or doesn't
 * know) and no pin lies inside its box. A place without a box is a point: nothing to outline.
 */
export function outlinePlace(c: PlaceCandidate, features: Pick<MapFeature, 'lat' | 'lng'>[]): boolean {
  if (!c.bbox) return false;
  if (c.boreholeCount != null && c.boreholeCount > 0) return false;
  const box = c.bbox;
  return !features.some((f) => insideBbox(f, box));
}

/** True for an answer that says the borehole does not exist (404), not that the route is missing. */
function notFound(e: unknown): boolean {
  return isApiError(e, 'borehole_not_found') || (e instanceof ApiError && e.status === 404 && e.code !== 'route_not_found');
}

/** True for the geocoder being unavailable (503). */
function geocoderDown(e: unknown): boolean {
  return isApiError(e, 'geocoder_unavailable') || (e instanceof ApiError && e.status === 503);
}

/** A request in flight, with the source asked. */
interface InFlight<T> { source: DataSource; done: boolean; promise: Promise<T> }

/** True when a request is still in flight at this source (tests and RETRY can swap sources). */
const sameSource = (a: InFlight<unknown> | undefined, source: DataSource) => !!a && !a.done && a.source === source;

export const createMapDataSlice: SliceCreator<MapDataSlice> = (ctx) => {
  const { set, get, find, takeBoreholes, isDeleted } = ctx;

  /** On-demand record loads in flight, per uid. */
  const recordFetches = new Map<string, InFlight<Borehole | null>>();
  /** Loads of a document's full records in flight, per document. */
  const documentFetches = new Map<string, InFlight<Borehole[]>>();
  /** Documents whose full list of records was loaded from that source. */
  const loadedDocuments = new Map<string, DataSource>();
  /** The map refresh in flight. */
  let mapFetch: { source: DataSource; again: boolean; promise: Promise<void> } | null = null;
  /** Bumped by every result-set action: answers of an older one are ignored. */
  let resultRun = 0;
  /** The result set being fetched by showResultSet, so the route sync asking again is the same request. */
  let showing: { id: string; source: DataSource; run: number; promise: Promise<void> } | null = null;
  /** Bumped by every place search. */
  let placeRun = 0;

  const setLoad = (uid: string, state: 'loading' | 'missing' | 'error') =>
    set((s) => (s.recordLoads[uid] === state ? {} : { recordLoads: { ...s.recordLoads, [uid]: state } }));

  const ofDocument = (documentId: string) => get().boreholes.filter((b) => b.documentId === documentId);

  /** True when every borehole of the document is cached since its full list was loaded from this source. */
  function complete(documentId: string, source: DataSource): boolean {
    if (loadedDocuments.get(documentId) !== source) return false;
    const s = get();
    const cached = new Set(s.boreholes.map((b) => b.uid));
    return s.features.every((f) => f.documentId !== documentId || cached.has(f.uid));
  }

  /**
   * Shows `rs` with its plotted members once both are known; with a navigator the id goes into the
   * map URL (history replace on the map, a new entry from another screen). `fit` flies to its bbox.
   * `toPanel` puts the set's definition into the filter panel (a set shown from a link or the chat),
   * so APPLY and an area drawn next go on from it; APPLY's own answer leaves the panel as it is now.
   */
  function present(rs: ResultSet, features: MapFeature[], fit: boolean, toPanel: boolean): void {
    set({
      resultSet: rs,
      resultSetFeatures: features,
      resultSetBusy: false,
      resultSetError: null,
      ...(toPanel ? { filter: copyFilter(rs.definition) } : {}),
      ...(fit && rs.bbox ? { mapOutline: { bbox: rs.bbox, outline: false, nonce: nextNonce() } } : {}),
    });
    showInUrl(rs.id);
  }

  /** Puts a result set id into the map URL (or the store, without a navigator). */
  function showInUrl(id: string | null): void {
    const s = get();
    if (!s.navigator) {
      set({ resultSetId: id });
      return;
    }
    const route = s.route;
    if (route?.kind === 'map') {
      if (route.rs !== id) s.showRoute({ ...route, rs: id });
    } else if (id) {
      s.showRoute({ kind: 'map', at: s.mapView, sel: null, rs: id });
    } else {
      set({ resultSetId: null });
    }
  }

  /** The failure of a result-set request as the panel shows it (an error answer, e.g. 422: the server's detail). */
  const resultFailure = (e: unknown) => (e instanceof ApiError ? e.detail : errorText(e));

  /** A bbox to fly to for a place, with its outline rule. */
  const outlineFor = (c: PlaceCandidate) => ({ bbox: placeBbox(c), outline: outlinePlace(c, get().features), nonce: nextNonce() });

  return {
    features: [],
    unplottedUids: [],
    filter: emptyFilter(),
    resultSet: null,
    resultSetFeatures: null,
    resultSetBusy: false,
    resultSetError: null,
    placeQuery: '',
    places: null,
    placeBusy: false,
    placeError: null,
    recordLoads: {},
    mapOutline: null,

    ensureBorehole(uid) {
      const cached = find(uid);
      if (cached) return Promise.resolve(cached);
      const source = get().source;
      if (!source) return Promise.resolve(null);
      const running = recordFetches.get(uid);
      if (sameSource(running, source)) return running!.promise;
      // Set before any await, so a route screen never paints "not found" for a record on its way.
      setLoad(uid, 'loading');
      const entry: InFlight<Borehole | null> = { source, done: false, promise: Promise.resolve(null) };
      entry.promise = (async (): Promise<Borehole | null> => {
        try {
          // A load of its document's records already on its way brings it too: no second request.
          const documentId = ctx.documentOf(uid);
          const docLoad = documentId ? documentFetches.get(documentId) : undefined;
          if (sameSource(docLoad, source)) {
            await docLoad!.promise.catch(() => undefined);
            const b = find(uid);
            if (b || get().source !== source) return b ?? null;
          }
          const record = await source.getBorehole(uid);
          if (get().source !== source) return null;
          takeBoreholes([record]);
          const b = find(uid);
          // Taken unless its document was deleted meanwhile.
          if (!b) setLoad(uid, 'missing');
          return b ?? null;
        } catch (e) {
          if (get().source !== source) return null;
          if (find(uid)) return find(uid) ?? null;
          setLoad(uid, notFound(e) ? 'missing' : 'error');
          if (!notFound(e)) console.warn(`Loading borehole ${uid} failed (${errorText(e)}).`);
          return null;
        } finally {
          entry.done = true;
          if (recordFetches.get(uid) === entry) recordFetches.delete(uid);
        }
      })();
      if (!entry.done) recordFetches.set(uid, entry);
      return entry.promise;
    },

    ensureDocumentBoreholes(documentId) {
      const source = get().source;
      if (!source) return Promise.resolve([]);
      if (complete(documentId, source)) return Promise.resolve(ofDocument(documentId));
      const running = documentFetches.get(documentId);
      if (sameSource(running, source)) return running!.promise;
      const entry: InFlight<Borehole[]> = { source, done: false, promise: Promise.resolve([]) };
      entry.promise = (async () => {
        try {
          const records = await source.documentBoreholes(documentId);
          if (get().source !== source) return [];
          takeBoreholes(records, documentId);
          if (!isDeleted(documentId)) loadedDocuments.set(documentId, source);
          return ofDocument(documentId);
        } finally {
          entry.done = true;
          if (documentFetches.get(documentId) === entry) documentFetches.delete(documentId);
        }
      })();
      if (!entry.done) documentFetches.set(documentId, entry);
      return entry.promise;
    },

    refreshMap() {
      const source = get().source;
      if (!source) return Promise.resolve();
      if (mapFetch && mapFetch.source === source) {
        mapFetch.again = true;
        return mapFetch.promise;
      }
      const entry = { source, again: true, promise: Promise.resolve() };
      mapFetch = entry;
      entry.promise = (async () => {
        while (entry.again) {
          entry.again = false;
          try {
            const [features, unplotted] = await Promise.all([source.mapFeatures(), source.unplotted()]);
            if (get().source !== source) break;
            const live = unplotted.filter((b) => !isDeleted(b.documentId));
            set({ features: features.filter((f) => !isDeleted(f.documentId)) });
            takeBoreholes(live);
            // The server's list is the whole NOT ON MAP list: boreholes placed since leave it.
            set({ unplottedUids: live.map((b) => b.uid) });
          } catch (e) {
            console.warn(`Map: reloading the pins and the NOT ON MAP list failed (${errorText(e)}).`);
          }
        }
        if (mapFetch === entry) mapFetch = null;
      })();
      return entry.promise;
    },

    setFilter(patch) {
      set((s) => ({ filter: { ...s.filter, ...patch } }));
    },

    async applyFilter() {
      const { source, filter } = get();
      if (!source) return;
      const run = ++resultRun;
      showing = null;
      set({ resultSetBusy: true, resultSetError: null });
      try {
        const rs = await source.createResultSet({ ...filter });
        if (run !== resultRun) return;
        const features = await source.resultSetFeatures(rs.id);
        if (run !== resultRun || get().source !== source) return;
        present(rs, features, true, false);
      } catch (e) {
        if (run === resultRun) set({ resultSetBusy: false, resultSetError: resultFailure(e) });
      }
    },

    async selectArea(area) {
      set((s) => ({ filter: { ...s.filter, area } }));
      await get().applyFilter();
    },

    showResultSet(id, options) {
      const source = get().source;
      if (!source) return Promise.resolve();
      if (showing && showing.id === id && showing.source === source) return showing.promise;
      if (get().resultSet?.id === id && !get().resultSetBusy) {
        // Already shown: only the URL and the fit.
        showInUrl(id);
        if (options?.fit) {
          const bbox = get().resultSet?.bbox;
          if (bbox) set({ mapOutline: { bbox, outline: false, nonce: nextNonce() } });
        }
        return Promise.resolve();
      }
      const run = ++resultRun;
      set({ resultSetBusy: true, resultSetError: null });
      const promise = (async () => {
        try {
          const answers = Promise.all([source.getResultSet(id), source.resultSetFeatures(id)]);
          // The URL names the set at once; the route sync, seeing it, asks for this same request.
          showInUrl(id);
          const [rs, features] = await answers;
          // Ignored when another result-set action came, or the URL moved on (Back) meanwhile.
          if (run !== resultRun || get().source !== source || get().resultSetId !== id) {
            if (run === resultRun) set({ resultSetBusy: false });
            return;
          }
          present(rs, features, options?.fit === true, true);
        } catch (e) {
          if (run === resultRun) set({ resultSetBusy: false, resultSetError: resultFailure(e) });
        } finally {
          if (showing?.run === run) showing = null;
        }
      })();
      showing = { id, source, run, promise };
      return promise;
    },

    clearResultSet() {
      resultRun += 1;
      showing = null;
      set({ resultSet: null, resultSetFeatures: null, resultSetBusy: false, resultSetError: null, filter: emptyFilter() });
      showInUrl(null);
    },

    async searchPlace(query) {
      const q = query.trim();
      const source = get().source;
      if (!q || !source) return;
      const run = ++placeRun;
      set({ placeQuery: q, places: null, placeBusy: true, placeError: null });
      try {
        const found = await source.geocode(q);
        if (run !== placeRun || get().source !== source) return;
        if (!found.length) {
          set({ places: [], placeBusy: false, placeError: NO_PLACE_FOUND });
          return;
        }
        set({ places: found, placeBusy: false, ...(found.length === 1 ? { mapOutline: outlineFor(found[0]) } : {}) });
      } catch (e) {
        if (run !== placeRun) return;
        set({ places: null, placeBusy: false, placeError: geocoderDown(e) ? PLACE_SEARCH_UNAVAILABLE : errorText(e) });
      }
    },

    choosePlace(index) {
      const c = get().places?.[index];
      if (c) set({ mapOutline: outlineFor(c) });
    },
  };
};

/** Forgets a deleted document's map data: its pins, its NOT ON MAP entries and its load states. */
export function withoutDocumentMapData(s: AppState, documentId: string, gone: Set<string>): Partial<AppState> {
  const features = s.features.filter((f) => f.documentId !== documentId);
  const unplottedUids = s.unplottedUids.filter((uid) => !gone.has(uid));
  const loads = Object.keys(s.recordLoads).some((uid) => gone.has(uid))
    ? Object.fromEntries(Object.entries(s.recordLoads).filter(([uid]) => !gone.has(uid)))
    : s.recordLoads;
  return {
    ...(features.length !== s.features.length ? { features } : {}),
    ...(unplottedUids.length !== s.unplottedUids.length ? { unplottedUids } : {}),
    ...(loads !== s.recordLoads ? { recordLoads: loads } : {}),
  };
}
