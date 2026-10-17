/**
 * Planned line view model (contract 1.3.0): which files the control takes, the drawn line as a GeoJSON
 * file for the same upload, the parsing of the EPSG and distance fields, and the table's texts.
 * Numbers are shown with the app's decimal point; a depth that is not stated stays blank.
 */
import type { AlignmentHit, AlignmentSide } from '../../../domain/types';
import { MAX_BUFFER_M } from '../../../store/alignmentSlice';

/** File types the server parses (POST /alignments). */
export const ALIGNMENT_EXTENSIONS = ['.geojson', '.json', '.kml', '.gpx', '.csv'] as const;
/** The file input's accept list. */
export const ALIGNMENT_ACCEPT = ALIGNMENT_EXTENSIONS.join(',');
/** Name of the file a drawn line is uploaded as. */
export const DRAWN_LINE_FILE = 'drawn-line.geojson';
export const DRAWN_LINE_NAME = 'Drawn line';

/** True for a file the planned-line control takes (by its extension, case-insensitive). */
export function isAlignmentFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ALIGNMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** True for a CSV, the only format whose x/y columns need an EPSG code. */
export const isCsv = (name: string) => name.toLowerCase().endsWith('.csv');

/**
 * A line drawn on the map as the GeoJSON file the upload sends: one Feature with a LineString of
 * [lng, lat] points in drawing order (rounded to 7 decimals, about 1 cm).
 */
export function drawnLineFile(points: readonly [number, number][], name = DRAWN_LINE_NAME): File {
  const round = (v: number) => Math.round(v * 1e7) / 1e7;
  const feature = {
    type: 'Feature',
    properties: { name },
    geometry: { type: 'LineString', coordinates: points.map(([lng, lat]) => [round(lng), round(lat)]) },
  };
  return new File([JSON.stringify(feature)], DRAWN_LINE_FILE, { type: 'application/geo+json' });
}

/** The EPSG field: blank is none, "25832" or "EPSG:25832" a code, anything else invalid. */
export function parseEpsg(text: string): number | null | 'invalid' {
  const t = text.trim().toUpperCase().replace(/^EPSG\s*:\s*/, '');
  if (!t) return null;
  return /^\d{4,6}$/.test(t) ? Number(t) : 'invalid';
}

/** The distance field: a number of metres above 0 and at most 1000 (decimal comma accepted), else null. */
export function parseBuffer(text: string): number | null {
  const v = Number(text.trim().replace(',', '.'));
  return text.trim() && Number.isFinite(v) && v > 0 && v <= MAX_BUFFER_M ? v : null;
}

/** "589 m": a chainage to the metre. */
export const chainageText = (m: number) => `${Math.round(m)} m`;
/** "39.8 m": an offset to the decimetre. */
export const offsetText = (m: number) => `${m.toFixed(1)} m`;
/** "1.43 km" from 1000 m, else "850 m": a line's length. */
export const lengthText = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
/** "12.00 m", blank when the depth is not stated. */
export const depthText = (m: number | null) => (m == null ? '' : `${m.toFixed(2)} m`);

/** English label of a side (translated by the panel). */
export const SIDE_LABEL: Record<AlignmentSide, string> = { left: 'Left', right: 'Right', on: 'On the line' };

/** The table's rows in the server's order (chainage, then offset); kept sorted should an answer not be. */
export function hitRows(hits: readonly AlignmentHit[]): AlignmentHit[] {
  return [...hits].sort((a, b) => a.chainageM - b.chainageM || a.offsetM - b.offsetM || a.uid.localeCompare(b.uid));
}
