/**
 * The chat request's `context` (contract ChatContext, FRONTEND.md F14): what the user is looking at
 * when they send a message. Built from the store at the moment of sending:
 * - selected_uids: the borehole selected on the map or open in Detail (the one open in Review there);
 * - active_result_set_id: the result set shown on the map;
 * - filters: the filter panel in the contract's shape, or null while nothing is set in it;
 * - map_view: only when the user asked about an area: the area drawn for the chat (request_area), else
 *   the visible map when "This map area" is on; null otherwise;
 * - units "m", ui_language from the browser, include_unreviewed from the drawer's toggle.
 */
import { toWireFilter } from '../data/adapters';
import type { Area, BoreholeFilter } from '../domain/types';
import type { MapView } from '../routing/urlState';
import type { AppState } from '../store/types';

type Bbox = [number, number, number, number];

/** The request's context in the contract's shape (ChatContext). */
export interface ChatContext {
  selected_uids: string[];
  active_result_set_id: string | null;
  filters: ReturnType<typeof toWireFilter> | null;
  map_view: { bbox: Bbox; zoom?: number } | null;
  units: 'm';
  ui_language: string | null;
  include_unreviewed: boolean;
}

/** What the context is built from. */
export type ContextState = Pick<
  AppState,
  'screen' | 'selectedUid' | 'reviewUid' | 'resultSet' | 'resultSetId' | 'filter' | 'mapView' | 'chatArea' | 'chatUseView' | 'chatIncludeUnreviewed'
>;

export interface ContextEnv {
  /** The browser's language (navigator.language), or null. */
  language: string | null;
  /** Width and height of the map on screen in px, or null when no map is shown. */
  mapSize: { width: number; height: number } | null;
}

/** True when the filter panel constrains nothing (include unreviewed alone is its default switch, not a filter). */
export function filterIsEmpty(f: BoreholeFilter): boolean {
  const blank = (s: string | null) => s == null || !s.trim();
  return (
    blank(f.search) && blank(f.country) && blank(f.project) && blank(f.documentId) &&
    f.minDepth == null && f.maxDepth == null && !f.dinCodes.length && f.lithologyMinDepth == null &&
    f.hasSpt == null && f.hasGroundwater == null && !f.reviewStatus.length && !f.area
  );
}

const EARTH_RADIUS_M = 6_378_137;
const MAX_LAT = 85.0511287798;

/** The bbox [min_lon, min_lat, max_lon, max_lat] around an area (a circle by its radius on the sphere). */
export function areaBbox(a: Area): Bbox {
  if (a.type === 'bbox') return [...a.bbox];
  if (a.type === 'circle') {
    const [lng, lat] = a.center;
    const dLat = (a.radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
    const cos = Math.cos((lat * Math.PI) / 180);
    const dLng = cos > 1e-9 ? dLat / cos : 180;
    return [Math.max(-180, lng - dLng), Math.max(-90, lat - dLat), Math.min(180, lng + dLng), Math.min(90, lat + dLat)];
  }
  const points = a.polygon.coordinates.flat();
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

/**
 * The bbox the map shows at a view (centre and zoom, Web Mercator with 256 px tiles as Leaflet's)
 * in a map of `size` px, clamped to the world.
 */
export function visibleBbox(view: MapView, size: { width: number; height: number }): Bbox {
  const world = 256 * 2 ** view.zoom;
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, view.lat));
  const x = ((view.lng + 180) / 360) * world;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
  const lngAt = (px: number) => (px / world) * 360 - 180;
  const latAt = (py: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / world))) * 180) / Math.PI;
  const clampLng = (v: number) => Math.max(-180, Math.min(180, v));
  const clampLat = (v: number) => Math.max(-90, Math.min(90, v));
  return [
    clampLng(lngAt(x - size.width / 2)),
    clampLat(latAt(y + size.height / 2)),
    clampLng(lngAt(x + size.width / 2)),
    clampLat(latAt(y - size.height / 2)),
  ];
}

/** Why "This map area" is off, or null when it can be used. */
export function viewOffReason(s: Pick<AppState, 'screen' | 'mapView'>, mapShown: boolean): string | null {
  if (s.screen !== 'map' || !mapShown) return 'Open the map to ask about the area it shows';
  if (!s.mapView) return 'The map has no view yet';
  return null;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** The context of a message sent now. */
export function buildChatContext(s: ContextState, env: ContextEnv): ChatContext {
  const uid = s.screen === 'review' ? s.reviewUid : s.selectedUid;
  let mapView: ChatContext['map_view'] = null;
  const zoom = s.mapView ? { zoom: s.mapView.zoom } : {};
  if (s.chatArea) {
    mapView = { bbox: areaBbox(s.chatArea).map(round6) as Bbox, ...zoom };
  } else if (s.chatUseView && s.screen === 'map' && s.mapView && env.mapSize && env.mapSize.width > 0 && env.mapSize.height > 0) {
    mapView = { bbox: visibleBbox(s.mapView, env.mapSize).map(round6) as Bbox, zoom: s.mapView.zoom };
  }
  return {
    selected_uids: uid ? [uid] : [],
    active_result_set_id: s.resultSet?.id ?? s.resultSetId ?? null,
    filters: filterIsEmpty(s.filter) ? null : toWireFilter(s.filter),
    map_view: mapView,
    units: 'm',
    ui_language: env.language || null,
    include_unreviewed: s.chatIncludeUnreviewed,
  };
}
