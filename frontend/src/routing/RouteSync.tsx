/**
 * The route sync: applies every location the router reports to the store (applyRoute), one way,
 * URL → store. It runs once the data is loaded (a deep link waits for the boot) and again when the
 * borehole of the route appears or goes. A layout effect, so a screen never paints with the previous
 * route's selection.
 *
 * It also asks for what the route needs that the boot does not load:
 * - /boreholes/:uid: the borehole's full record; /review/:uid: the record and its document's
 *   records (the CRS dialog, approve-clean and the borehole switcher work per document). The store's
 *   recordLoads says LOADING or BOREHOLE NOT FOUND meanwhile; it is set before the first paint.
 * - /map?rs=: the result set the URL names (fitted to its bbox when the URL names no view).
 */
import { useLayoutEffect, useMemo } from 'react';
import { useLocation } from 'react-router';
import { errorText } from '../data/errors';
import { useAppStore } from '../store/appStore';
import { parseLocation, routeUid, type AppRoute } from './urlState';

/** What the current location shows. */
export function useLocationRoute(): AppRoute {
  const { pathname, search } = useLocation();
  return useMemo(() => parseLocation(pathname, search), [pathname, search]);
}

/** Loads the records a review or detail route needs (each at most once at a time; cached ones are not fetched). */
export function ensureRouteRecords(kind: 'review' | 'detail', uid: string): void {
  const s = useAppStore.getState();
  const warn = (e: unknown) => console.warn(`Loading the boreholes of the review document failed (${errorText(e)}).`);
  if (kind === 'detail') {
    void s.ensureBorehole(uid);
    return;
  }
  // The document is known from the pin (or a cached record): both loads start at once, and the
  // record comes with the document's records (one request) when that load is on its way.
  const known = s.features.find((f) => f.uid === uid)?.documentId ?? s.boreholes.find((b) => b.uid === uid)?.documentId ?? null;
  if (known) s.ensureDocumentBoreholes(known).catch(warn);
  void s.ensureBorehole(uid).then((b) => {
    if (b?.documentId && b.documentId !== known) useAppStore.getState().ensureDocumentBoreholes(b.documentId).catch(warn);
  });
}

export function RouteSync() {
  const route = useLocationRoute();
  const ready = useAppStore((s) => s.loadState === 'ready');
  const source = useAppStore((s) => s.source);
  const uid = routeUid(route);
  const known = useAppStore((s) => uid !== null && s.boreholes.some((b) => b.uid === uid));
  const applyRoute = useAppStore((s) => s.applyRoute);
  // The generated sheet needs the same full record as the detail.
  const recordKind = route.kind === 'review' || route.kind === 'detail' ? route.kind : route.kind === 'sheet' ? 'detail' : null;
  const rs = route.kind === 'map' ? route.rs : null;
  const fit = route.kind === 'map' && route.at === null;

  useLayoutEffect(() => {
    if (ready) applyRoute(route);
  }, [route, ready, known, applyRoute]);

  // Full records on demand: before the paint, so the route screen shows LOADING, never "not found".
  useLayoutEffect(() => {
    if (ready && uid && recordKind) ensureRouteRecords(recordKind, uid);
  }, [ready, uid, recordKind, source]);

  // The result set the map URL names (a reload, a shared link, Back).
  useLayoutEffect(() => {
    if (!ready || !rs) return;
    const s = useAppStore.getState();
    // `fit` is read, not a dependency: it only matters when the set is first shown.
    if (s.resultSet?.id !== rs) void s.showResultSet(rs, { fit });
  }, [ready, rs, source]);

  return null;
}
