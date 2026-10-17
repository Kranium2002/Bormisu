/**
 * The app's URLs (FRONTEND.md section 3 "Routing", F4), built and read in this one place. Pure: no
 * React and no router, so the store and its tests use it too.
 *
 *   /                               redirects to /map (and reads as the map until it has)
 *   /map?at=<lat>,<lng>,<zoom>&sel=<uid>&rs=<result set id>
 *   /queue
 *   /review                         the review target, else "nothing to review"
 *   /review/:uid?key=<value key>
 *   /boreholes/:uid?layer=<n>
 *   /inbox?q=<clarification id>     the questions, with the open one's dialog
 *   anything else                   not found
 *
 * The path names the screen (a new history entry); the query holds state within the screen (the map
 * view, the selected pin, the focused value, the selected layer), which changes with history replace.
 * A query value that can't be read is ignored, never guessed.
 */

/** Route patterns of the router (relative to the root route). */
export const ROUTE = {
  map: 'map',
  queue: 'queue',
  reviewIndex: 'review',
  review: 'review/:uid',
  detail: 'boreholes/:uid',
  inbox: 'inbox',
  list: 'list',
  sheet: 'sheet/:uid',
} as const;

/** Centre and zoom of the map. */
export interface MapView { lat: number; lng: number; zoom: number }

/** The map's URL state. */
export interface MapUrlState {
  /** Centre and zoom; null lets the map fit the pins. */
  at: MapView | null;
  /** The borehole selected or focused on the map (its popup is open). */
  sel: string | null;
  /** Result set id: reserved for area selection and filters (F10), kept in the URL until then. */
  rs: string | null;
}

/** What a URL shows. */
export type AppRoute =
  | ({ kind: 'map' } & MapUrlState)
  | { kind: 'queue' }
  | { kind: 'reviewIndex' }
  | { kind: 'review'; uid: string; key: string | null }
  | { kind: 'detail'; uid: string; layer: number | null }
  /** The inbox; `q` is the question whose dialog is open (FRONTEND.md F12). */
  | { kind: 'inbox'; q: string | null }
  /** Every borehole as a table (also those not on the map). */
  | { kind: 'list' }
  /** The generated borehole sheet of a record, printable; `lang` is the sheet's language when set. */
  | { kind: 'sheet'; uid: string; lang: string | null }
  | { kind: 'notFound'; path: string };

export type RouteKind = AppRoute['kind'];

/** About a metre of latitude; zoom snaps to quarters, so two decimals keep it exact. */
const LATLNG_DECIMALS = 5;
const ZOOM_DECIMALS = 2;
/** Zoom levels a map URL may ask for (Leaflet's tile zoom stays far below the upper bound). */
const MAX_ZOOM = 30;

const round = (x: number, decimals: number) => {
  const r = Number(x.toFixed(decimals));
  return Object.is(r, -0) ? 0 : r;
};

/** "lat,lng,zoom" for the `at` parameter. */
export function formatMapView(v: MapView): string {
  return `${round(v.lat, LATLNG_DECIMALS)},${round(v.lng, LATLNG_DECIMALS)},${round(v.zoom, ZOOM_DECIMALS)}`;
}

/** The view as the URL holds it (rounded), so a view read back from the URL compares equal. */
export function roundMapView(v: MapView): MapView {
  return { lat: round(v.lat, LATLNG_DECIMALS), lng: round(v.lng, LATLNG_DECIMALS), zoom: round(v.zoom, ZOOM_DECIMALS) };
}

/** Reads `at`; null unless it is three finite numbers with a latitude on the globe and a usable zoom. */
export function parseMapView(text: string): MapView | null {
  const parts = text.split(',');
  if (parts.length !== 3 || parts.some((p) => p.trim() === '')) return null;
  const [lat, lng, zoom] = parts.map(Number);
  if (![lat, lng, zoom].every(Number.isFinite)) return null;
  if (lat < -90 || lat > 90 || zoom < 0 || zoom > MAX_ZOOM) return null;
  return { lat, lng, zoom };
}

/** A query value, or null when absent or empty. */
function param(q: URLSearchParams, name: string): string | null {
  const v = q.get(name);
  return v ? v : null;
}

/** A positive whole number, or null. */
function positiveInt(text: string | null): number | null {
  if (!text || !/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && Number.isSafeInteger(n) ? n : null;
}

/** The decoded path segments, or null when a segment is not valid percent-encoding. */
function segments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter(Boolean);
  try {
    return parts.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/** What the location shows (pathname as the router reports it, search with or without "?"). */
export function parseLocation(pathname: string, search: string): AppRoute {
  const q = new URLSearchParams(search);
  const seg = segments(pathname);
  const notFound: AppRoute = { kind: 'notFound', path: pathname };
  if (!seg) return notFound;
  const [head, uid, ...rest] = seg;
  if (rest.length) return notFound;
  // The root redirects to /map (once the data is loaded): until then it shows the map too.
  if (head === undefined) return { kind: 'map', at: null, sel: null, rs: null };
  if (head === 'map' && uid === undefined) {
    const at = param(q, 'at');
    return { kind: 'map', at: at ? parseMapView(at) : null, sel: param(q, 'sel'), rs: param(q, 'rs') };
  }
  if (head === 'queue' && uid === undefined) return { kind: 'queue' };
  if (head === 'review') return uid ? { kind: 'review', uid, key: param(q, 'key') } : { kind: 'reviewIndex' };
  if (head === 'boreholes' && uid) return { kind: 'detail', uid, layer: positiveInt(param(q, 'layer')) };
  if (head === 'inbox' && uid === undefined) return { kind: 'inbox', q: param(q, 'q') };
  if (head === 'list' && uid === undefined) return { kind: 'list' };
  if (head === 'sheet' && uid) return { kind: 'sheet', uid, lang: param(q, 'lang') };
  return notFound;
}

const enc = encodeURIComponent;

/** "?a=1&b=2" from the pairs whose value is set; '' when none is. */
function query(pairs: [string, string | null][]): string {
  const set = pairs.filter((p): p is [string, string] => p[1] !== null);
  return set.length ? `?${set.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
}

/** /map with its view, selection and result set (only the parts that are set). */
export function mapPath(s: MapUrlState): string {
  // `at` holds only digits, signs, dots and commas: it stays readable.
  return `/${ROUTE.map}${query([
    ['at', s.at ? formatMapView(s.at) : null],
    ['sel', s.sel ? enc(s.sel) : null],
    ['rs', s.rs ? enc(s.rs) : null],
  ])}`;
}

/** /review/:uid, with the focused value when given. */
export function reviewPath(uid: string, key?: string | null): string {
  return `/review/${enc(uid)}${query([['key', key ? enc(key) : null]])}`;
}

/** /boreholes/:uid, with the selected layer when given. */
export function boreholePath(uid: string, layer?: number | null): string {
  return `/boreholes/${enc(uid)}${query([['layer', layer != null ? String(layer) : null]])}`;
}

/** /inbox, with the question whose dialog is open when given. */
export function inboxPath(q?: string | null): string {
  return `/${ROUTE.inbox}${query([['q', q ? enc(q) : null]])}`;
}

/** /sheet/:uid, with the sheet's language when given. */
export function sheetPath(uid: string, lang?: string | null): string {
  return `/sheet/${enc(uid)}${query([['lang', lang ? enc(lang) : null]])}`;
}

/** The URL of a route. */
export function routePath(r: AppRoute): string {
  switch (r.kind) {
    case 'map':
      return mapPath(r);
    case 'queue':
      return `/${ROUTE.queue}`;
    case 'reviewIndex':
      return `/${ROUTE.reviewIndex}`;
    case 'review':
      return reviewPath(r.uid, r.key);
    case 'detail':
      return boreholePath(r.uid, r.layer);
    case 'inbox':
      return inboxPath(r.q);
    case 'list':
      return `/${ROUTE.list}`;
    case 'sheet':
      return sheetPath(r.uid, r.lang);
    case 'notFound':
      return r.path;
  }
}

/** The borehole a route is about, or null. */
export function routeUid(r: AppRoute | null): string | null {
  return r && (r.kind === 'review' || r.kind === 'detail' || r.kind === 'sheet') ? r.uid : null;
}

/** True when both routes show the same screen (same kind and borehole); query state does not count. */
export function sameScreen(a: AppRoute | null, b: AppRoute | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'notFound' && b.kind === 'notFound') return a.path === b.path;
  return routeUid(a) === routeUid(b);
}
