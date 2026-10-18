/**
 * The report's small static map: the selection's boreholes (numbered as in the summary table), the
 * planned line with its band or the drawn area, over basemap tiles, as plain numbers for one <svg>
 * (Web Mercator, the tiles' own projection). Static on purpose: it prints and saves as PDF like the rest
 * of the page, which a live Leaflet map does not.
 */
import type { Area } from '../domain/types';

export const MAP_W = 680;
export const MAP_H = 300;
const TILE = 256;
const PAD = 28;
const MAX_ZOOM = 17;
const MIN_ZOOM = 2;
/** Points drawn with their number; beyond this they are dots (the table has the numbers). */
export const NUMBERED_MAX = 60;
/** Numbered points closer than this (px) are fanned out around their spot, joined to it by a leader. */
const OVERLAP_PX = 15;

export interface MapPoint { no: number; lat: number; lng: number; status: string }

export interface ExtractInput {
  points: MapPoint[];
  /** Planned line parts, [lng, lat]. */
  line?: [number, number][][];
  /** The band around the line: polygons of rings of [lng, lat]. */
  band?: [number, number][][][];
  area?: Area | null;
}

export interface MapTile { x: number; y: number; href: string }

export interface MapExtract {
  zoom: number;
  tiles: MapTile[];
  /** x/y where the point is drawn; ax/ay its true position (different when fanned out). */
  points: (MapPoint & { x: number; y: number; ax: number; ay: number })[];
  numbered: boolean;
  /** SVG path data. */
  line: string | null;
  band: string | null;
  area: { kind: 'path'; d: string } | { kind: 'circle'; cx: number; cy: number; r: number } | null;
  scale: { px: number; label: string };
}

/** World pixel of a WGS84 position at a zoom level. */
export function project(lng: number, lat: number, zoom: number): [number, number] {
  const size = TILE * 2 ** zoom;
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lng + 180) / 360) * size, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size];
}

/** Metres per pixel at a latitude and zoom. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** zoom);
}

/** The [lng, lat] corners of a circle's bounding box (for fitting the view). */
function circleBounds(a: Extract<Area, { type: 'circle' }>): [number, number][] {
  const dLat = a.radiusM / 111_320;
  const dLng = a.radiusM / (111_320 * Math.max(0.01, Math.cos((a.center[1] * Math.PI) / 180)));
  return [
    [a.center[0] - dLng, a.center[1] - dLat],
    [a.center[0] + dLng, a.center[1] + dLat],
  ];
}

function areaPoints(a: Area): [number, number][] {
  if (a.type === 'bbox') return [[a.bbox[0], a.bbox[1]], [a.bbox[2], a.bbox[3]]];
  if (a.type === 'circle') return circleBounds(a);
  return a.polygon.coordinates.flat() as [number, number][];
}

/** "200 m" / "1 km" scale bar of about 90 px. */
function scaleBar(lat: number, zoom: number): { px: number; label: string } {
  const mpp = metresPerPixel(lat, zoom);
  const target = mpp * 90;
  const p = 10 ** Math.floor(Math.log10(target));
  const m = [1, 2, 5, 10].map((f) => f * p).reverse().find((v) => v <= target) ?? p;
  return { px: m / mpp, label: m >= 1000 ? `${m / 1000} km` : `${m} m` };
}

/**
 * Points that would hide each other's numbers (boreholes of one site, a log and its copy) are fanned
 * out on a small circle around their common spot; each keeps its true position as `ax/ay`.
 */
export function fanOut<P extends { x: number; y: number }>(points: readonly P[], within = OVERLAP_PX): (P & { ax: number; ay: number })[] {
  const out = points.map((p) => ({ ...p, ax: p.x, ay: p.y }));
  const group = new Array<number>(points.length).fill(-1);
  const groups: number[][] = [];
  points.forEach((_p, i) => {
    if (group[i] >= 0) return;
    const g = [i];
    group[i] = groups.length;
    for (let j = i + 1; j < points.length; j++) {
      if (group[j] < 0 && g.some((k) => Math.hypot(points[j].x - points[k].x, points[j].y - points[k].y) < within)) {
        g.push(j);
        group[j] = groups.length;
      }
    }
    groups.push(g);
  });
  for (const g of groups) {
    if (g.length < 2) continue;
    const cx = g.reduce((s, k) => s + points[k].x, 0) / g.length;
    const cy = g.reduce((s, k) => s + points[k].y, 0) / g.length;
    const r = Math.max(within, (g.length * 17) / (2 * Math.PI));
    g.forEach((k, n) => {
      const a = -Math.PI / 2 + (2 * Math.PI * n) / g.length;
      out[k].x = cx + r * Math.cos(a);
      out[k].y = cy + r * Math.sin(a);
    });
  }
  return out;
}

/** The extract, or null when nothing of the selection has a map position. */
export function mapExtract(input: ExtractInput, tileUrl: string): MapExtract | null {
  const coords: [number, number][] = [
    ...input.points.map((p) => [p.lng, p.lat] as [number, number]),
    ...(input.line ?? []).flat(),
    ...(input.area ? areaPoints(input.area) : []),
  ];
  if (!coords.length) return null;
  // The largest zoom at which everything fits inside the padded frame.
  let zoom = MAX_ZOOM;
  for (; zoom > MIN_ZOOM; zoom--) {
    const px = coords.map(([lng, lat]) => project(lng, lat, zoom));
    const w = Math.max(...px.map((p) => p[0])) - Math.min(...px.map((p) => p[0]));
    const h = Math.max(...px.map((p) => p[1])) - Math.min(...px.map((p) => p[1]));
    if (w <= MAP_W - 2 * PAD && h <= MAP_H - 2 * PAD) break;
  }
  const px = coords.map(([lng, lat]) => project(lng, lat, zoom));
  const cx = (Math.max(...px.map((p) => p[0])) + Math.min(...px.map((p) => p[0]))) / 2;
  const cy = (Math.max(...px.map((p) => p[1])) + Math.min(...px.map((p) => p[1]))) / 2;
  const ox = cx - MAP_W / 2;
  const oy = cy - MAP_H / 2;
  const at = (lng: number, lat: number): [number, number] => {
    const [x, y] = project(lng, lat, zoom);
    return [x - ox, y - oy];
  };
  const pathOf = (ring: readonly [number, number][], close: boolean) =>
    ring.map(([lng, lat], i) => `${i ? 'L' : 'M'}${at(lng, lat).map((v) => v.toFixed(1)).join(' ')}`).join('') + (close ? 'Z' : '');

  const n = 2 ** zoom;
  const tiles: MapTile[] = [];
  for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + MAP_W) / TILE); tx++) {
    for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + MAP_H) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      tiles.push({
        x: tx * TILE - ox,
        y: ty * TILE - oy,
        href: tileUrl.replace('{z}', String(zoom)).replace('{x}', String(wx)).replace('{y}', String(ty)).replace('{s}', 'a').replace('{r}', ''),
      });
    }
  }

  let area: MapExtract['area'] = null;
  if (input.area?.type === 'circle') {
    const [x, y] = at(input.area.center[0], input.area.center[1]);
    area = { kind: 'circle', cx: x, cy: y, r: input.area.radiusM / metresPerPixel(input.area.center[1], zoom) };
  } else if (input.area?.type === 'bbox') {
    const [w, s, e, nn] = input.area.bbox;
    area = { kind: 'path', d: pathOf([[w, s], [e, s], [e, nn], [w, nn]], true) };
  } else if (input.area?.type === 'polygon') {
    area = { kind: 'path', d: input.area.polygon.coordinates.map((r) => pathOf(r as [number, number][], true)).join('') };
  }

  const midLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const numbered = input.points.length <= NUMBERED_MAX;
  const placed = input.points.map((p) => {
    const [x, y] = at(p.lng, p.lat);
    return { ...p, x, y };
  });
  return {
    zoom,
    tiles,
    points: numbered ? fanOut(placed) : placed.map((p) => ({ ...p, ax: p.x, ay: p.y })),
    numbered,
    line: input.line?.length ? input.line.map((part) => pathOf(part, false)).join('') : null,
    band: input.band?.length ? input.band.map((poly) => poly.map((r) => pathOf(r, true)).join('')).join('') : null,
    area,
    scale: scaleBar(midLat, zoom),
  };
}
