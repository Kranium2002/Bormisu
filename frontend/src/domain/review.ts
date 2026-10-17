/** Pure review logic: statuses, "approve all clean", progress, completeness, value patches. */
import { parseNumber } from './format';
import { K } from './keys';
import { parseSptText, sptLint } from './spt';
import { syncTestValue } from './testResults';
import type {
  Borehole,
  BoreholeStatus,
  Completeness,
  CrsCandidate,
  ExtractedValue,
  Spt,
  ValuePatch,
} from './types';

/**
 * Review status of a borehole:
 * `attention` if the CRS is inferred, a value is flagged, or a value has a lint and isn't approved;
 * otherwise `reviewed` when every value is approved; otherwise `unreviewed`.
 */
export function boreholeStatus(b: Borehole): BoreholeStatus {
  if (b.crs.status === 'inferred') return 'attention';
  if (b.values.some((v) => v.status === 'flagged' || (v.lint && v.status !== 'approved'))) return 'attention';
  if (b.values.length > 0 && b.values.every((v) => v.status === 'approved')) return 'reviewed';
  return 'unreviewed';
}

/** True if a value is "clean": unreviewed, method Read, no lint, no flag, state ok. */
export function isClean(v: ExtractedValue): boolean {
  return v.status === 'unreviewed' && v.method === 'Read' && !v.lint && !v.flag && v.state === 'ok';
}

/** Keys that "Approve all clean" approves. */
export function cleanKeys(b: Borehole): string[] {
  return b.values.filter(isClean).map((v) => v.key);
}

/** Approved values out of all values. */
export function progress(b: Borehole): { approved: number; total: number } {
  return { approved: b.values.filter((v) => v.status === 'approved').length, total: b.values.length };
}

/**
 * The value the Review screen focuses first: the CRS when inferred, else the first open lint,
 * else the first flag, else the first unreviewed value, else the first value.
 */
export function initialFocusKey(b: Borehole): string | null {
  const vs = b.values;
  const pick =
    (b.crs.status === 'inferred' ? vs.find((v) => v.key === K.crs) : undefined) ??
    vs.find((v) => v.lint && v.status !== 'approved') ??
    vs.find((v) => v.status === 'flagged') ??
    vs.find((v) => v.status === 'unreviewed') ??
    vs[0];
  return pick ? pick.key : null;
}

export type CompletenessTone = 'ok' | 'warning' | 'error';
export interface CompletenessSummary {
  listed: number;
  extracted: number;
  tone: CompletenessTone;
  /** Queue chip, e.g. "Report lists 14 · extracted 13 · ⚠ 1 missing". */
  chipText: string;
  /** Completeness panel heading, e.g. "Report lists 14 · extracted 13 · 1 missing". */
  headText: string;
  ids: { id: string; state: 'extracted' | 'missing' | 'unexpected' }[];
}

/** Summarises a document's completeness check for the queue chip and the Completeness panel. */
export function completenessSummary(c: Completeness): CompletenessSummary {
  const extracted = c.listed - c.missing.length;
  const m = c.missing.length;
  const tone: CompletenessTone = m ? 'error' : c.lint.length ? 'warning' : 'ok';
  const expected =
    c.expectedIds ?? Array.from({ length: c.listed }, (_, i) => c.idPrefix + String(i + 1).padStart(2, '0'));
  const ids = [
    ...expected.map((id) => ({ id, state: c.missing.includes(id) ? ('missing' as const) : ('extracted' as const) })),
    ...c.unexpected.map((id) => ({ id, state: 'unexpected' as const })),
  ];
  return {
    listed: c.listed,
    extracted,
    tone,
    chipText: `Report lists ${c.listed} · extracted ${extracted}` + (m ? ` · ⚠ ${m} missing` : ' ✓'),
    headText: `Report lists ${c.listed} · extracted ${extracted}` + (m ? ` · ${m} missing` : ''),
    ids,
  };
}

/**
 * Patch for saving an inline edit: a changed value becomes Edited + approved, an unchanged one is
 * approved. Any non-empty text also clears a "not in source" / "illegible" state, because the
 * reviewer has just typed what the source says.
 */
export function editPatch(v: ExtractedValue, text: string): ValuePatch {
  const t = text.trim();
  const clearState: ValuePatch = t && v.state !== 'ok' ? { state: 'ok' } : {};
  if (t && t !== v.value) return { value: t, method: 'Edited', status: 'approved', ...clearState };
  return { status: 'approved', ...clearState };
}

/** Patch for a "Not in source" / "Illegible" button: sets the state, or resets it when it is already set. */
export function statePatch(v: ExtractedValue, state: Exclude<ExtractedValue['state'], 'ok'>): ValuePatch {
  return v.state === state ? { state: 'ok', status: 'unreviewed' } : { state, status: 'approved' };
}

/** Patch for saving a flag; an empty reason becomes "needs a second look". */
export function flagPatch(reason: string): ValuePatch {
  return { flag: reason.trim() || 'needs a second look', status: 'flagged' };
}

/** Patch that removes a flag. */
export const UNFLAG_PATCH: ValuePatch = { status: 'unreviewed', flag: undefined };

/** The patchable fields of a value, e.g. to roll an optimistic update back. */
export function patchOf(v: ExtractedValue): ValuePatch {
  return { value: v.value, status: v.status, state: v.state, flag: v.flag, method: v.method };
}

const LAYER_KEY = /^layer\[(\d+)\]\.(\w+)$/;

/**
 * Keeps the structured SPT in step with an edited SPT text: N or refusal, the R badge, the layer's
 * SPT (profile marker, export) and an increment lint that was computed from the old N.
 */
function syncSpt(b: Borehole, v: ExtractedValue, n: number): Borehole {
  const prev = v.spt;
  if (!prev) return b;
  // Unreadable text keeps no N at all: a stale N would be exported as if it were reviewed.
  const spt: Spt = parseSptText(v.value, prev) ?? {
    raw: prev.raw, depth: prev.depth, refusal: false, ...(prev.increments ? { increments: prev.increments } : {}),
  };
  // A lint from elsewhere (e.g. the backend) stays; the increment check follows the new N.
  const recompute = !v.lint || v.lint.message === sptLint(prev)?.message;
  const next: ExtractedValue = { ...v, spt, refusal: spt.refusal, lint: recompute ? sptLint(spt) : v.lint };
  return {
    ...b,
    values: b.values.map((x) => (x.key === v.key ? next : x)),
    layers: b.layers.map((l) => (l.n === n ? { ...l, spt } : l)),
  };
}

/** Keeps the numeric borehole model (depths, layers, groundwater, SPT) in step with an edited value. */
function syncDerived(b: Borehole, v: ExtractedValue): Borehole {
  const num = parseNumber(v.value);
  // An empty final depth is unknown again (e.g. a rolled-back edit); other text keeps the last number.
  if (v.key === K.finalDepth) return { ...b, finalDepth: num ?? (v.value.trim() ? b.finalDepth : null) };
  if (v.key === K.rockHead && num != null) return { ...b, rockHead: num };
  if (b.groundwater.some((g) => g.key === v.key) && num != null) {
    return { ...b, groundwater: b.groundwater.map((g) => (g.key === v.key ? { ...g, depth: num } : g)) };
  }
  const test = syncTestValue(b, v.key, num);
  if (test) return test;
  const m = LAYER_KEY.exec(v.key);
  if (!m) return b;
  const n = Number(m[1]);
  if (m[2] === 'lithology') {
    return { ...b, layers: b.layers.map((l) => (l.n === n ? { ...l, lithology: v.value } : l)) };
  }
  if (m[2] === 'bottom' && num != null) {
    const layers = b.layers.map((l) =>
      l.n === n ? { ...l, to: num } : l.n === n + 1 ? { ...l, from: num } : l,
    );
    return { ...b, layers, logBottom: layers.length ? layers[layers.length - 1].to : b.logBottom };
  }
  if (m[2] === 'spt') return syncSpt(b, v, n);
  return b;
}

/** Applies a review patch to one value of a borehole (immutably) and syncs derived numbers. */
export function applyValuePatch(b: Borehole, key: string, patch: ValuePatch): Borehole {
  const current = b.values.find((v) => v.key === key);
  if (!current) return b;
  const next = { ...current, ...patch };
  const updated = { ...b, values: b.values.map((v) => (v.key === key ? next : v)) };
  return patch.value !== undefined ? syncDerived(updated, next) : updated;
}

/**
 * Confirms a CRS for a borehole: status `confirmed`, its CRS value approved with the candidate name
 * (and no longer "not in source"), and its position taken from the candidate's point, which also
 * puts it on the map. A candidate that contradicts the AI's guess marks the value as Edited.
 */
export function confirmCrsOn(b: Borehole, c: CrsCandidate): Borehole {
  const point = c.points.find((p) => p.uid === b.uid);
  return {
    ...b,
    ...(point ? { lat: point.lat, lng: point.lng, onMap: true, unplottedReason: null } : {}),
    crs: { name: c.name, code: c.code, status: 'confirmed' },
    values: b.values.map((v) =>
      v.key === K.crs
        ? { ...v, value: c.name, status: 'approved', state: 'ok', method: c.verdict === 'match' ? v.method : 'Edited' }
        : v,
    ),
  };
}
