/** Formatting and parsing for display: depths, numbers and short status texts. */
import { UNPLOTTED_LABELS, type Borehole, type Lint } from './types';

/**
 * Formats a number with a decimal comma: 18 -> "18,00". Only for text as a source prints it (the
 * fictional sample's logs); the app shows numbers with a decimal point (`decimal`).
 */
export function decimalComma(v: number, digits = 2): string {
  return v.toFixed(digits).replace('.', ',');
}

/** Formats a number with the app's decimal point: 18 -> "18.00" (the profile labels use it too). */
export function decimal(v: number, digits = 2): string {
  return v.toFixed(digits);
}

/**
 * A lint as text. A check the app adds itself (e.g. SPT increments) says so: it is no backend
 * finding and never makes a borehole "needs attention".
 */
export function lintText(l: Lint): string {
  return l.client ? `${l.message} (checked by the app, not the backend)` : l.message;
}

/** Formats a depth in metres: 11.2 -> "11.20 m". Null gives an empty string (a blank never means 0). */
export function metres(v: number | null | undefined, digits = 2): string {
  return v == null ? '' : `${v.toFixed(digits)} m`;
}

/**
 * Parses a normalised or printed number: "18.00", "18,00", "3 513 420" -> number.
 * Returns null for anything that isn't a plain number.
 */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/**
 * Why a borehole is not on the map, from the backend's reason code (UNPLOTTED_LABELS). Without a
 * code it says only that the borehole isn't placed: no reason is made up.
 */
export function unplottedText(b: Pick<Borehole, 'unplottedReason'>): string {
  return b.unplottedReason ? UNPLOTTED_LABELS[b.unplottedReason] : 'Not placed on the map';
}

/**
 * Name of a borehole's coordinate system: the server's label of its code, else the system as printed,
 * else the server's EPSG code (a CRS confirmed by a reviewer often has only the code). Null when the
 * server knows none of them.
 */
export function crsLabel(crs: Pick<Borehole['crs'], 'name' | 'code' | 'label'>): string | null {
  return crs.label?.trim() || crs.name?.trim() || crs.code?.trim() || null;
}

/** Coordinates as printed, e.g. "512 000 / 5 540 000 (E / N)"; '' when the source gives none. */
export function printedCoordinates(meta: Pick<Borehole['meta'], 'xRaw' | 'yRaw' | 'axisLabelsRaw'>): string {
  const xy = [meta.xRaw, meta.yRaw].filter((t): t is string => !!t?.trim()).join(' / ');
  if (!xy) return '';
  return meta.axisLabelsRaw?.trim() ? `${xy} (${meta.axisLabelsRaw.trim()})` : xy;
}
