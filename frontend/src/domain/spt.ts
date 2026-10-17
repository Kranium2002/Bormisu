/** SPT helpers. A refusal ("50/30") is never an N value: N = 50 must not appear anywhere. */
import type { Lint, Spt } from './types';

/**
 * Checks a non-refusal SPT: the 2nd + 3rd increments must add up to N.
 * Returns an error lint like "Increments 4 + 5 = 9 ≠ N 8", or undefined when consistent. The backend
 * has no such rule, so the lint is the client's own (`client: true`): shown, never counted as attention.
 */
export function sptLint(spt: Spt): Lint | undefined {
  const inc = spt.increments;
  if (spt.refusal || spt.n == null || !inc || inc.length < 3) return undefined;
  const sum = inc[1] + inc[2];
  if (sum === spt.n) return undefined;
  return { severity: 'error', message: `Increments ${inc[1]} + ${inc[2]} = ${sum} ≠ N ${spt.n}`, client: true };
}

/** Normalised display text: "N = 8" or "refusal · 50 blows / 30 cm". */
export function formatSpt(spt: Spt): string {
  if (!spt.refusal) return spt.n == null ? spt.raw : `N = ${spt.n}`;
  if (spt.blows == null || spt.penetrationCm == null) return `refusal · ${spt.raw}`;
  return `refusal · ${spt.blows} blows / ${spt.penetrationCm} cm`;
}

/**
 * Depth of a test as text: "10.50 m", or "depth not stated" when the source gives none. Outside the
 * profile drawing a test never gets an invented depth (no layer midpoint).
 */
export function sptDepthText(spt: Pick<Spt, 'depth'>): string {
  return spt.depth == null ? 'depth not stated' : `${spt.depth.toFixed(2)} m`;
}

/** Tooltip for the amber R badge: explains the raw refusal string. */
export function refusalTitle(spt: Spt): string {
  if (spt.blows == null || spt.penetrationCm == null) return `Raw “${spt.raw}”: SPT refusal. Not an N value.`;
  return `Raw “${spt.raw}”: ${spt.blows} blows for ${spt.penetrationCm} cm penetration. Not N = ${spt.blows}.`;
}

/**
 * Reads a reviewer's SPT text back into the structured SPT: "N = 9" or "9" is an N value,
 * "50/30" or "refusal · 50 blows / 30 cm" a refusal. Keeps what was printed (raw, depth, increments).
 * Returns null for text it can't read, so callers never keep a stale N.
 */
export function parseSptText(text: string, prev: Spt): Spt | null {
  const t = text.trim().toLowerCase();
  const keep = {
    raw: prev.raw,
    depth: prev.depth,
    ...(prev.increments ? { increments: prev.increments } : {}),
    ...(prev.incrementMm != null ? { incrementMm: prev.incrementMm } : {}),
  };
  const n = /^(?:n\s*=\s*)?(\d+)$/.exec(t);
  if (n) return { ...keep, refusal: false, n: Number(n[1]) };
  const r = /(\d+)\s*(?:blows)?\s*\/\s*(\d+)\s*(?:cm)?$/.exec(t);
  if (r) return { ...keep, refusal: true, blows: Number(r[1]), penetrationCm: Number(r[2]) };
  if (/^refusal\b/.test(t)) {
    return { ...keep, refusal: true, ...(prev.refusal ? { blows: prev.blows, penetrationCm: prev.penetrationCm } : {}) };
  }
  return null;
}

/** Export cell of a refusal the reviewer entered: "50/30" when blows and penetration are known. */
export function refusalText(spt: Spt, fallback: string): string {
  return spt.blows != null && spt.penetrationCm != null ? `${spt.blows}/${spt.penetrationCm}` : fallback;
}
