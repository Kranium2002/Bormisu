/**
 * Maps the backend shapes (snake_case, docs/design/api-contract.md §5) to the domain.
 * Unknown values stay empty with state "not in source": never a default value.
 */
import { K } from '../domain/keys';
import { formatSpt, sptLint } from '../domain/spt';
import type {
  Borehole,
  Box,
  CrsCandidate,
  CrsStatus,
  DocumentStep,
  DocumentSummary,
  ExtractedValue,
  FieldState,
  GroundwaterReading,
  GroundwaterType,
  Layer,
  Lint,
  LintFinding,
  Method,
  PageType,
  PatternId,
  ReviewStatus,
  Spt,
} from '../domain/types';
import { EXTRA_FIELDS, multiField, type ValueFieldName } from '../schema/targetFormat';
import { PATTERN_FILLS } from '../theme';

/* ---------- backend shapes ---------- */

export interface ApiProvenance {
  page?: number | null;
  box?: [number, number, number, number] | null;
  raw?: string | null;
  method?: string | null;
  confidence?: number | null;
  status?: string | null;
  state?: string | null;
  ai_value?: unknown;
  flag?: string | null;
}

export interface ApiLayer {
  depth_from_m: number;
  depth_to_m: number;
  original_description?: string | null;
  english_lithology?: string | null;
  din4023_code?: string | null;
  rqd_pct?: number | null;
  core_recovery_pct?: number | null;
  spt_n_value?: number | null;
  spt_raw?: string | null;
  spt_refusal?: boolean | null;
  spt_increments?: number[] | null;
  spt_penetration_cm?: number | null;
  spt_depth_m?: number | null;
}

export interface ApiBoreholeRecord {
  uid?: string;
  document_id?: string | null;
  source_file?: string | null;
  crs_status?: CrsStatus | null;
  plotted?: boolean | null;
  unplotted_reason?: string | null;
  rock_head_m?: number | null;
  metadata: {
    borehole_id: string;
    project_name?: string | null;
    drilling_date?: string | null;
    borehole_depth_m?: number | null;
    surface_elevation_mASL?: number | null;
    notes?: string | null;
    coordinates?: {
      latitude?: number | null;
      longitude?: number | null;
      local_x?: number | null;
      local_y?: number | null;
      coordinate_system?: string | null;
    } | null;
  };
  stratigraphy?: ApiLayer[] | null;
  groundwater?: { type: string; depth_m: number | null; date?: string | null }[] | null;
  geotechnical_tests?: { water_table_m?: number | null } | null;
  provenance?: Record<string, ApiProvenance> | null;
  lint?: { path: string; rule?: string; severity: 'warning' | 'error'; message: string }[] | null;
}

export type ApiDocumentStatus = 'queued' | 'classifying' | 'extracting' | 'needs_review' | 'done' | 'failed';

export interface ApiDocument {
  document_id: string;
  file_name: string;
  status: ApiDocumentStatus;
  error?: string | null;
  page_count?: number | null;
  found?: { boreholes: number; layers: number; spt: number; groundwater: number } | null;
  pages?: { n: number; type: string; used: boolean; unused_reason?: string | null }[] | null;
  completeness?: { expected_ids: string[]; found_ids: string[]; missing: string[]; unexpected: string[] } | null;
}

export interface ApiCrsCandidate {
  crs: string;
  label: string;
  points: { uid: string; lat: number; lon: number }[];
}

/* ---------- small mappers ---------- */

const METHODS: Record<string, Method> = { read: 'Read', ocr: 'OCR', derived: 'Derived', guessed: 'Guessed', edited: 'Edited' };
const STATES: Record<string, FieldState> = { ok: 'ok', not_in_source: 'not in source', illegible: 'illegible' };
const PAGE_TYPES: PageType[] = ['log', 'lab_table', 'text', 'drawing', 'photo', 'unknown'];

function toBox(b: ApiProvenance['box']): Box | null {
  return b ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null;
}

function toStatus(s: string | null | undefined): ReviewStatus {
  return s === 'approved' || s === 'flagged' ? s : 'unreviewed';
}

/** Domain field state → backend `state` (for PATCH bodies). */
export function toApiState(s: FieldState): string {
  return Object.keys(STATES).find((k) => STATES[k] === s) ?? 'ok';
}

const isRockText = (t: string) => /stone|rock|granit|gneis|basalt|schist|quartzit|chalk|\bsst\b|\bkst\b|\bmst\b/i.test(t);

/** Named rocks and special soils, checked first (order matters: "sandstone" before "sand"). */
const NAMED: [RegExp, PatternId][] = [
  [/topsoil|mutterboden|^mu\b/, 'topsoil'],
  [/\bfill\b|made ground|auff|^a\b/, 'fill'],
  [/sandstone|^sst\b/, 'sst'],
  [/limestone|chalk|dolo|^kst\b/, 'lst'],
  [/marl|till|boulder clay|mergel|^mst\b|^mg\b/, 'marl'],
];
/** Main soil types; the first one named (ignoring adjectives like "silty") is the main component. */
const SOILS: [RegExp, PatternId][] = [
  [/gravel|kies|^g\b/, 'gravel'],
  [/clay|\bton\b|^t\b/, 'clay'],
  [/silt|loess|schluff|^u\b/, 'silt'],
  [/sand|^s\b/, 'sand'],
];
const ADJECTIVES = /\b(silty|sandy|gravelly|clayey|loamy|humic)\b/g;

function classify(text: string): PatternId | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const named = NAMED.find(([re]) => re.test(t));
  if (named) return named[1];
  const nouns = t.replace(ADJECTIVES, ' ');
  let best: { at: number; id: PatternId } | null = null;
  for (const [re, id] of SOILS) {
    const m = re.exec(nouns);
    if (m && (!best || m.index < best.at)) best = { at: m.index, id };
  }
  return best?.id ?? null;
}

/** Picks a DIN 4023 hatching: from the DIN code first, else the English lithology (best effort, default sand). */
export function patternFor(din: string, lithology: string): PatternId {
  return classify(din) ?? classify(lithology) ?? 'sand';
}

const depthText = (v: number) => v.toFixed(2);
const GROUP_ORDER: Record<ExtractedValue['group'], number> = { borehole: 0, groundwater: 1, layer: 2 };

/* ---------- borehole ---------- */

/** How an edited value is sent to the backend: a number, a string as typed, or an SPT N value. */
export type ApiValueType = 'number' | 'string' | 'spt';

/**
 * Where a value lives in the backend record. A value that holds two fields (X / Y) has two paths:
 * its provenance is combined from both, and an edit is split on " / " into one update per path.
 */
export interface ApiTarget {
  paths: string[];
  type: ApiValueType;
}

interface ValueSpec {
  key: string;
  /** Backend path, or the two paths of a two-field value. */
  path: string | readonly [string, string];
  field: ValueFieldName;
  label: string;
  group: ExtractedValue['group'];
  value: string | number | null | undefined;
  unit?: string;
  layer?: number;
  method?: Method;
  /** How an edit is sent back (default: string). */
  type?: ApiValueType;
  /** Raw text when the provenance has none, e.g. the printed lithology. */
  rawFallback?: string;
  extra?: Partial<ExtractedValue>;
}

/** A domain borehole plus the backend target of each value key (for PATCH requests). */
export interface AdaptedBorehole {
  borehole: Borehole;
  targets: Record<string, ApiTarget>;
}

type ApiBox = NonNullable<ApiProvenance['box']>;

/** Smallest box around two boxes. */
function unionBox(a: ApiBox, b: ApiBox): ApiBox {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

/** Provenance of a two-field value (X / Y): both raws, both boxes, approved only when both are. */
function combineProvenance(a: ApiProvenance | undefined, b: ApiProvenance | undefined): ApiProvenance | undefined {
  if (!a || !b) return a ?? b;
  const status =
    a.status === 'flagged' || b.status === 'flagged' ? 'flagged' : a.status === 'approved' && b.status === 'approved' ? 'approved' : 'unreviewed';
  return {
    ...a,
    page: a.page ?? b.page,
    box: a.box && b.box && a.page === b.page ? unionBox(a.box, b.box) : (a.box ?? b.box),
    raw: [a.raw, b.raw].filter(Boolean).join(' / ') || null,
    confidence: Math.min(a.confidence ?? 0, b.confidence ?? 0),
    status,
    state: a.state && a.state !== 'ok' ? a.state : b.state,
    ai_value: a.ai_value != null && b.ai_value != null ? `${a.ai_value} / ${b.ai_value}` : null,
    flag: a.flag ?? b.flag,
  };
}

/** Lint of one value from several findings: the worst severity, every message. */
function mergeLint(a: Lint | undefined, b: Lint): Lint {
  if (!a) return b;
  return { severity: a.severity === 'error' || b.severity === 'error' ? 'error' : 'warning', message: `${a.message} · ${b.message}` };
}

/**
 * The review row a backend lint finding is shown on. Every finding gets one, so none is lost: its own
 * value, else the layer's bottom depth (a layer's start depth is the boundary with the layer above),
 * the groundwater reading, the X / Y value, and finally the borehole ID.
 */
function lintAnchor(path: string, targets: Record<string, ApiTarget>): string {
  const exact = Object.keys(targets).find((k) => targets[k].paths.includes(path));
  if (exact) return exact;
  const layer = /^stratigraphy\[(\d+)\]\.?(\w*)/.exec(path);
  if (layer) {
    const i = Number(layer[1]);
    const n = layer[2] === 'depth_from_m' && i > 0 ? i : i + 1;
    if (targets[K.bottom(n)]) return K.bottom(n);
  }
  const gw = /^groundwater\[(\d+)\]/.exec(path);
  if (gw && targets[K.gw(Number(gw[1]))]) return K.gw(Number(gw[1]));
  if (path.startsWith('metadata.coordinates')) return K.xy;
  return K.boreholeId;
}

/** Maps one backend BoreholeRecord to a domain Borehole. */
export function adaptBorehole(rec: ApiBoreholeRecord): AdaptedBorehole {
  const md = rec.metadata;
  const co = md.coordinates ?? {};
  const prov = rec.provenance ?? {};
  const targets: Record<string, ApiTarget> = {};
  const values: ExtractedValue[] = [];

  const add = (s: ValueSpec): ExtractedValue => {
    const paths = typeof s.path === 'string' ? [s.path] : [...s.path];
    const p = paths.length === 1 ? prov[paths[0]] : combineProvenance(prov[paths[0]], prov[paths[1]]);
    const text = s.value == null ? '' : typeof s.value === 'number' ? String(s.value) : s.value;
    const v: ExtractedValue = {
      key: s.key,
      field: s.field,
      label: s.label,
      group: s.group,
      layer: s.layer,
      raw: p?.raw ?? s.rawFallback ?? '',
      value: text,
      unit: s.unit ?? '',
      page: p?.page ?? null,
      box: toBox(p?.box),
      method: (p?.method && METHODS[p.method.toLowerCase()]) || s.method || 'Guessed',
      confidence: p?.confidence ?? 0,
      status: toStatus(p?.status),
      state: (p?.state && STATES[p.state]) || (text ? 'ok' : 'not in source'),
      aiValue: p?.ai_value == null ? text : String(p.ai_value),
      ...(p?.flag ? { flag: p.flag } : {}),
      ...s.extra,
    };
    values.push(v);
    targets[s.key] = { paths, type: s.type ?? 'string' };
    return v;
  };
  const meta = (
    key: string, path: ValueSpec['path'], field: ValueFieldName, label: string, value: ValueSpec['value'], unit = '',
    type: ApiValueType = unit ? 'number' : 'string',
  ) => add({ key, path, field, label, group: 'borehole', value, unit, type });

  const lat = co.latitude ?? null;
  const lng = co.longitude ?? null;
  const hasLatLng = lat != null && lng != null && !(lat === 0 && lng === 0);
  const hasLocal = co.local_x != null && co.local_y != null;
  // X is the easting (local x, or longitude), Y the northing (local y, or latitude).
  const xyPaths = hasLocal || !hasLatLng
    ? (['metadata.coordinates.local_x', 'metadata.coordinates.local_y'] as const)
    : (['metadata.coordinates.longitude', 'metadata.coordinates.latitude'] as const);

  meta(K.boreholeId, 'metadata.borehole_id', 'BoreholeID', 'Borehole ID', md.borehole_id);
  meta(K.project, 'metadata.project_name', 'ProjectName', 'Project', md.project_name);
  meta(K.startDate, 'metadata.drilling_date', 'StartDate', 'Start date', md.drilling_date);
  meta(K.finalDepth, 'metadata.borehole_depth_m', 'BoreholeDepth', 'Final depth',
    md.borehole_depth_m == null ? null : depthText(md.borehole_depth_m), 'm');
  meta(K.elevation, 'metadata.surface_elevation_mASL', 'Surface Elevation', 'Surface elevation',
    md.surface_elevation_mASL == null ? null : md.surface_elevation_mASL.toFixed(2), 'mASL');
  meta(K.xy, xyPaths, multiField('X-Coordinate', 'Y-Coordinate'), 'X / Y',
    hasLocal ? `${co.local_x} / ${co.local_y}` : hasLatLng ? `${lng} / ${lat}` : null, '', 'number');
  meta(K.crs, 'metadata.coordinates.coordinate_system', 'CoordinateSystem', 'CRS', co.coordinate_system).kind = 'crs';

  const layers: Layer[] = (rec.stratigraphy ?? []).map((l, i) => adaptLayer(l, i, add));
  const rockLayer = layers.find((l) => isRockText(`${l.din} ${l.lithology}`));
  const rockHead = rec.rock_head_m ?? rockLayer?.from ?? null;
  if (rockHead != null) {
    add({
      key: K.rockHead, path: 'rock_head_m', field: EXTRA_FIELDS.rockHead, label: 'Rock head', group: 'borehole',
      value: depthText(rockHead), unit: 'm', method: 'Derived', type: 'number',
      extra: rec.rock_head_m == null && rockLayer ? { formula: `top of first rock layer (layer ${rockLayer.n})` } : {},
    });
  }
  meta(K.notes, 'metadata.notes', 'Notes', 'Remarks', md.notes);

  const groundwater = adaptGroundwater(rec, add);
  const logBottom = layers.length ? layers[layers.length - 1].to : 0;
  const firstPage = Object.values(prov).find((p) => p.page != null)?.page ?? 1;
  const documentId = rec.document_id ?? null;

  // Every backend finding lands on a review row; then SPT increments that don't add up, unless linted already.
  for (const l of rec.lint ?? []) {
    const v = values.find((x) => x.key === lintAnchor(l.path, targets));
    if (v) v.lint = mergeLint(v.lint, { severity: l.severity, message: l.message });
  }
  for (const v of values) {
    const lint = v.spt && !v.lint ? sptLint(v.spt) : undefined;
    if (lint) v.lint = lint;
  }

  // Review order: borehole fields, then groundwater, then layers (sort is stable).
  values.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);

  return {
    targets,
    borehole: {
      uid: rec.uid ?? `${documentId ?? 'doc'}:${md.borehole_id}`,
      id: md.borehole_id,
      documentId,
      sourceFile: rec.source_file ?? '',
      project: md.project_name ?? '',
      lat: hasLatLng ? lat : null,
      lng: hasLatLng ? lng : null,
      onMap: rec.plotted ?? hasLatLng,
      unplottedReason: rec.unplotted_reason ?? (hasLatLng ? null : 'No coordinates in source'),
      // Unknown stays unknown: the log bottom only bounds the drawing, it is not the final depth.
      finalDepth: md.borehole_depth_m ?? null,
      logBottom,
      crs: {
        name: co.coordinate_system ?? null,
        code: co.coordinate_system && /^EPSG:\d+$/i.test(co.coordinate_system) ? co.coordinate_system : null,
        status: rec.crs_status ?? (co.coordinate_system ? 'stated' : 'unknown'),
      },
      layers,
      groundwater,
      rockHead,
      values,
      primaryPage: firstPage,
    },
  };
}

function adaptLayer(l: ApiLayer, i: number, add: (s: ValueSpec) => ExtractedValue): Layer {
  const n = i + 1;
  const base = `stratigraphy[${i}]`;
  const din = l.din4023_code ?? '';
  const english = l.english_lithology ?? '';
  const printed = l.original_description ?? '';
  const pattern = patternFor(din, english);
  add({
    key: K.bottom(n), path: `${base}.depth_to_m`, field: EXTRA_FIELDS.depthTo, label: 'Bottom depth', group: 'layer', layer: n,
    value: depthText(l.depth_to_m), unit: 'm', type: 'number',
  });
  const lith = add({
    key: K.lithology(n), path: `${base}.english_lithology`, field: 'Lithology/SoilName', label: 'Lithology',
    group: 'layer', layer: n, value: english, rawFallback: printed, extra: { kind: 'lithology', din },
  });
  const spt = adaptSpt(l);
  if (spt) {
    // The increment lint is added once the backend's own findings are attached (adaptBorehole).
    add({
      key: K.spt(n), path: `${base}.spt_n_value`, field: 'SPT', label: `SPT @ ${spt.depth.toFixed(2)} m`,
      group: 'layer', layer: n, value: formatSpt(spt), method: 'Read', rawFallback: spt.raw, type: 'spt',
      extra: { kind: 'spt', spt, refusal: spt.refusal },
    });
  }
  if (l.core_recovery_pct != null) {
    add({ key: K.tcr(n), path: `${base}.core_recovery_pct`, field: 'TotalCoreRecovery', label: 'TCR',
      group: 'layer', layer: n, value: l.core_recovery_pct, unit: '%', type: 'number' });
  }
  if (l.rqd_pct != null) {
    add({ key: K.rqd(n), path: `${base}.rqd_pct`, field: 'RQD', label: 'RQD', group: 'layer', layer: n,
      value: l.rqd_pct, unit: '%', type: 'number' });
  }
  return {
    n,
    from: l.depth_from_m,
    to: l.depth_to_m,
    lithology: english,
    lithologyAsPrinted: printed,
    din,
    pattern,
    fill: din || english ? PATTERN_FILLS[pattern] : '#EEEEEE',
    strat: '',
    method: lith.method,
    confidence: lith.confidence,
    ...(spt ? { spt } : {}),
    ...(l.core_recovery_pct != null ? { tcr: l.core_recovery_pct } : {}),
    ...(l.rqd_pct != null ? { rqd: l.rqd_pct } : {}),
  };
}

function adaptSpt(l: ApiLayer): Spt | null {
  if (l.spt_raw == null && l.spt_n_value == null && !l.spt_refusal) return null;
  const refusal = !!l.spt_refusal;
  const depth = l.spt_depth_m ?? Math.round(((l.depth_from_m + l.depth_to_m) / 2) * 100) / 100;
  const inc = l.spt_increments ?? undefined;
  return {
    raw: l.spt_raw ?? (l.spt_n_value != null ? `N = ${l.spt_n_value}` : 'refusal'),
    depth,
    refusal,
    ...(inc ? { increments: inc } : {}),
    ...(!refusal && l.spt_n_value != null ? { n: l.spt_n_value } : {}),
    ...(refusal && inc?.length ? { blows: inc[0] } : {}),
    ...(l.spt_penetration_cm != null ? { penetrationCm: l.spt_penetration_cm } : {}),
  };
}

const GW_TYPES: readonly GroundwaterType[] = ['strike', 'rest', 'standpipe', 'other'];
const GW_VALUE_LABEL: Record<GroundwaterType, string> = {
  strike: 'GW strike', rest: 'GW rest level', standpipe: 'GW standpipe', other: 'GW reading',
};

/**
 * Every groundwater reading, keyed by its index in the backend list. A record without the list falls
 * back to the legacy `geotechnical_tests.water_table_m` (a rest level), with that path as provenance.
 */
function adaptGroundwater(rec: ApiBoreholeRecord, add: (s: ValueSpec) => ExtractedValue): GroundwaterReading[] {
  const legacy = rec.groundwater == null ? rec.geotechnical_tests?.water_table_m : null;
  const list = legacy != null ? [{ type: 'rest', depth_m: legacy, date: null }] : (rec.groundwater ?? []);
  const out: GroundwaterReading[] = [];
  list.forEach((g, i) => {
    if (g.depth_m == null) return;
    const type = GW_TYPES.find((t) => t === g.type) ?? 'other';
    // Several readings of one type: tell them apart by date, else by count ("GW rest level 2").
    const same = list.filter((x) => x.type === g.type && x.depth_m != null);
    const nth = same.indexOf(g) + 1;
    const suffix = same.length < 2 ? '' : g.date ? ` (${g.date})` : ` ${nth}`;
    const key = K.gw(i);
    add({
      key, path: legacy != null ? 'geotechnical_tests.water_table_m' : `groundwater[${i}].depth_m`, field: 'Groundwaterlevel',
      label: GW_VALUE_LABEL[type] + suffix, group: 'groundwater', value: depthText(g.depth_m), unit: 'm bgl', type: 'number',
    });
    out.push({ type, depth: g.depth_m, key });
  });
  return out;
}

/** Lint findings of a document for the Completeness panel: every linted value of its boreholes. */
export function documentLint(boreholes: Borehole[], documentId: string): LintFinding[] {
  return boreholes
    .filter((b) => b.documentId === documentId)
    .flatMap((b) => b.values.flatMap((v) => (v.lint ? [{ severity: v.lint.severity, boreholeId: b.id, message: v.lint.message }] : [])));
}

/* ---------- documents ---------- */

const STEP: Record<ApiDocumentStatus, DocumentStep> = {
  queued: 0, classifying: 0, extracting: 1, needs_review: 2, done: 3, failed: 0,
};

/** True once the backend has stopped working on a document. */
export function isTerminal(status: ApiDocumentStatus): boolean {
  return status === 'needs_review' || status === 'done' || status === 'failed';
}

/** Maps a backend document to a DocumentSummary (project + review borehole are filled in by the caller). */
export function adaptDocument(d: ApiDocument): DocumentSummary {
  const count = d.page_count ?? d.pages?.length ?? 0;
  const pageTypes: PageType[] = Array.from({ length: count }, () => 'unknown');
  for (const p of d.pages ?? []) {
    if (p.n >= 1 && p.n <= count) pageTypes[p.n - 1] = PAGE_TYPES.includes(p.type as PageType) ? (p.type as PageType) : 'unknown';
  }
  const c = d.completeness;
  return {
    id: d.document_id,
    name: d.file_name,
    project: '',
    pageTypes,
    step: STEP[d.status] ?? 0,
    counts: d.found ?? null,
    completeness: c
      ? { listed: c.expected_ids.length, idPrefix: '', missing: c.missing, unexpected: c.unexpected, lint: [], expectedIds: c.expected_ids }
      : null,
    reviewBoreholeUid: null,
    error: d.status === 'failed' ? d.error || 'Extraction failed' : null,
  };
}

/** Usage note of one backend page, e.g. "used: log" or "unused: cover page". */
export function apiPageUsage(d: ApiDocument, page: number): string {
  const p = d.pages?.find((x) => x.n === page);
  if (!p) return 'not classified yet';
  return p.used ? `used: ${p.type}` : `unused: ${p.unused_reason ?? p.type}`;
}

/** Maps backend CRS candidates. The backend gives no verdict, so a candidate without points is out of range. */
export function adaptCrsCandidates(list: ApiCrsCandidate[]): CrsCandidate[] {
  return list.map((c) => ({
    name: c.label,
    code: c.crs,
    note: c.points.length ? `${c.points.length} boreholes placed` : 'Coordinates out of range for this CRS.',
    verdict: c.points.length ? 'match' : 'out_of_range',
    points: c.points.map((p) => ({ uid: p.uid, lat: p.lat, lng: p.lon })),
  }));
}
