/**
 * Maps the backend's wire shapes (contracts/openapi.yaml, generated into ./api-types.gen) to the
 * domain. This module and apiSource.ts are the only ones that know wire field names.
 * Unknown stays unknown (null or ''): never a default value the source doesn't state.
 */
import { K } from '../domain/keys';
import { placeholderPage } from '../domain/pages';
import { formatSpt, sptLint } from '../domain/spt';
import type {
  Alignment,
  AlignmentHit,
  AlignmentResult,
  Area,
  Borehole,
  BoreholeFilter,
  BoreholeMeta,
  BoreholeReviewStatus,
  Box,
  Clarification,
  ClarificationKind,
  ClarificationStatus,
  CrsCandidate,
  CrsStatus,
  DocumentPage,
  DocumentStatus,
  DocumentStep,
  DocumentSummary,
  Evidence,
  ExtractedValue,
  FieldState,
  FormField,
  FormWidget,
  GroundwaterReading,
  GroundwaterType,
  Health,
  Layer,
  Lint,
  LintFinding,
  LiveEvent,
  MapFeature,
  Method,
  PlaceCandidate,
  Reading,
  ResultSet,
  ReviewStatus,
  Sample,
  Spt,
  TestResult,
  User,
} from '../domain/types';
import { EXTRA_FIELDS, multiField, section } from '../schema/targetFormat';
import type { components } from './api-types.gen';

/* ---------- wire types (generated from the contract) ---------- */

type Schemas = components['schemas'];
export type WireHealth = Schemas['Health'];
export type WireDocument = Schemas['Document'];
export type WireDocumentList = Schemas['DocumentList'];
export type WirePage = Schemas['Page'];
export type WireBorehole = Schemas['BoreholeRecord'];
export type WireBoreholeList = Schemas['BoreholeList'];
export type WireLayer = Schemas['Layer'];
export type WireProvenance = Schemas['Provenance'];
export type WireCrsCandidate = Schemas['CrsCandidate'];
export type WireCrsConfirm = Schemas['CrsConfirmRequest'];
export type WireValuePatch = Schemas['ValuePatch'];
export type WireUploadAccepted = Schemas['UploadAccepted'];
export type WireError = Schemas['Error'];
export type WireClarification = Schemas['Clarification'];
export type WireClarificationAnswer = Schemas['ClarificationAnswer'];
export type WireFormField = Schemas['FormField'];
export type WireEvidence = Schemas['Evidence'];
export type WireFeatureCollection = Schemas['BoreholeFeatureCollection'];
export type WireFeature = WireFeatureCollection['features'][number];
export type WireFilter = Schemas['BoreholeFilter'];
export type WireArea = Schemas['AreaBbox'] | Schemas['AreaPolygon'] | Schemas['AreaCircle'];
export type WireResultSet = Schemas['ResultSet'];
export type WirePlace = Schemas['PlaceCandidate'];
export type WireAlignment = Schemas['Alignment'];
export type WireAlignmentList = Schemas['AlignmentList'];
export type WireAlignmentQuery = Schemas['AlignmentQuery'];
export type WireAlignmentHit = Schemas['AlignmentHit'];
export type WireAlignmentResult = Schemas['AlignmentResult'];

/**
 * The `data` of each server-sent event of GET /events. These shapes live in
 * contracts/realtime-and-chat.md section 1, not in the OpenAPI file, so they are written out here.
 */
export interface WireEventData {
  'document.updated': WireDocument;
  'document.deleted': { document_id: string };
  'borehole.created': { uid: string; document_id: string; revision: number; plotted: boolean };
  'borehole.updated': { uid: string; revision: number };
  'clarification.created': WireClarification;
  /** document_id and borehole_uids since 1.2.0. */
  'clarification.resolved': { clarification_id: string; status: 'answered' | 'skipped'; document_id?: string; borehole_uids?: string[] };
  'job.failed': { document_id: string; stage: string; detail: string; retryable: boolean };
}

/* ---------- small mappers ---------- */

const METHODS: Record<Schemas['Method'], Method> = { read: 'Read', ocr: 'OCR', derived: 'Derived', guessed: 'Guessed', edited: 'Edited' };
const STATES: Record<WireProvenance['state'], FieldState> = { ok: 'ok', not_in_source: 'not in source', illegible: 'illegible' };

function toBox(b: WireProvenance['box'] | undefined): Box | null {
  return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null;
}

function toStatus(s: WireProvenance['status'] | undefined): ReviewStatus {
  return s === 'approved' || s === 'flagged' ? s : 'unreviewed';
}

/** Domain field state → backend `state` (for PATCH bodies). */
export function toApiState(s: FieldState): NonNullable<WireValuePatch['state']> {
  return s === 'not in source' ? 'not_in_source' : s === 'illegible' ? 'illegible' : 'ok';
}

/**
 * A depth or level as text: at least two decimals ("15.50"), never fewer digits than the server sent
 * ("3.425" stays "3.425"): exports read the number back from this text.
 */
const depthText = (v: number) => {
  const s = String(v);
  return /e/i.test(s) || (s.split('.')[1]?.length ?? 0) < 2 ? v.toFixed(2) : s;
};

/** Display text of a wire value: numbers as digits, booleans as yes / no, lists joined, null as ''. */
function wireText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.map(wireText).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ---------- value paths ---------- */

/** Reads the wire value at a provenance path such as `stratigraphy[2].spt_n_value`; undefined when absent. */
export function valueAt(rec: WireBorehole, path: string): unknown {
  let cur: unknown = rec;
  for (const part of path.split('.')) {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(part);
    if (!m || cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    if (m[2] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
  }
  return cur;
}

/** How an edited value is sent to the backend: a number, a boolean, a string as typed, or an SPT N value. */
export type PatchValueType = 'number' | 'string' | 'boolean' | 'spt';

/**
 * Where a value lives in the backend record: the provenance paths a PATCH targets. A value that holds
 * two fields (X / Y) keeps the whole `pair` (X first) and the `current` text of each; an edit is split
 * on " / " and each part goes to its path when that path is a provenance key. A part whose path is not
 * a provenance key can't be saved, so it must stay as it is.
 */
export interface PatchTarget {
  paths: string[];
  type: PatchValueType;
  pair?: readonly [string, string];
  current?: readonly [string, string];
  /** Why an edit is refused before sending (approve, flag, state and reset still work); same text as the value's readOnlyReason. */
  readOnly?: string;
  /** SPT row on the N value: the layer's spt_raw path when it is a provenance key; a text that is no whole N goes there. */
  sptRaw?: string;
}

/** A domain borehole plus the backend target of each patchable value key. */
export interface AdaptedBorehole {
  borehole: Borehole;
  /** Only values whose paths are provenance keys are patchable. */
  targets: Record<string, PatchTarget>;
  /**
   * Paths of the values shown without a provenance entry (read-only). The contract allows sparse
   * provenance, so this is no error; the data source logs one summary per load.
   */
  unsourced: string[];
}

interface ValueSpec {
  key: string;
  /** Backend path, or the X / Y pair. */
  path: string | readonly [string, string];
  field: string;
  label: string;
  group: ExtractedValue['group'];
  /** Wire value(s); for a pair, the display text is built by the caller. */
  value: unknown;
  /** Display text of the value; default wireText. */
  text?: string;
  /** Formats a numeric wire value (also applied to ai_value). */
  format?: (n: number) => string;
  unit?: string;
  layer?: number;
  index?: number;
  type?: PatchValueType;
  /** Raw text when the provenance has none, e.g. the printed lithology. */
  rawFallback?: string;
  /** Forces a row even when the value is null and has no provenance (e.g. an SPT refusal without N). */
  shown?: boolean;
  /** Why the value can't be edited here although it has provenance (PatchTarget.readOnly). */
  readOnly?: string;
  /** PatchTarget.sptRaw. */
  sptRaw?: string;
  extra?: Partial<ExtractedValue>;
}

/** The CRS code is set only through the CRS dialog (POST /documents/{id}/crs); the backend refuses edits of it. */
const CRS_CODE = 'metadata.coordinates.crs_code';
const CHOOSE_CRS = 'Set the coordinate system with CHOOSE CRS…';

const GROUP_ORDER: Record<ExtractedValue['group'], number> = { borehole: 0, groundwater: 1, layer: 2, sample: 3, test: 4 };

/** Smallest box around two boxes. */
function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Lint of one value from several findings: the worst severity, every message. */
function mergeLint(a: Lint | undefined, b: Lint): Lint {
  if (!a) return b;
  return { severity: a.severity === 'error' || b.severity === 'error' ? 'error' : 'warning', message: `${a.message} · ${b.message}` };
}

function toReadings(list: WireProvenance['readings']): Reading[] | undefined {
  if (!list?.length) return undefined;
  return list.map((r) => ({ reader: r.reader ?? '', text: r.text ?? '', confidence: r.confidence ?? null }));
}

/** Labels of wire fields that have no dedicated row: provenance keys the backend adds beyond the known ones. */
const GENERIC_LABELS: Record<string, string> = {
  depth_from_m: 'Top depth', thickness_m: 'Thickness', original_description: 'Description as printed',
  description_language: 'Description language', din4023_code: 'DIN 4023 code', din4023_notation: 'DIN 4023 notation',
  uscs_group: 'USCS group', spt_n_value: 'SPT N', spt_raw: 'SPT as printed', spt_refusal: 'SPT refusal', spt_increments: 'SPT increments',
  spt_increment_mm: 'SPT increment length', spt_penetration_cm: 'SPT penetration', spt_depth_m: 'SPT depth',
  elevation_m: 'GW elevation', date: 'Date', raw: 'As printed', type: 'Type', type_code: 'Sample type',
  depth_to_m: 'Depth to', latitude: 'Latitude', longitude: 'Longitude', crs_code: 'CRS code', x_raw: 'X as printed',
  y_raw: 'Y as printed', axis_labels_raw: 'Axis labels as printed', aliases: 'Aliases', borehole_depth_source: 'Depth source',
  qualifier: 'Qualifier', unit: 'Unit', sample_name: 'Sample', depth_m: 'Depth',
};

const NUMERIC_FIELD = /(_m|_pct|_mpa|_deg|_cm|_mm|_mASL|_value)$/;

/** Units of wire fields without a dedicated row, by the end of the field name (depths are below). */
const GENERIC_UNITS: [RegExp, string][] = [[/_cm$/, 'cm'], [/_mm$/, 'mm'], [/_pct$/, '%'], [/_mpa$/, 'MPa'], [/_deg$/, '°']];

/** A latitude or longitude the backend derived (a CRS transform): at most 7 decimals, so no float noise. */
const derivedDegrees = (v: number) => String(Number(v.toFixed(7)));

/**
 * Unit and number format of a wire field without a dedicated row: depths (`*_m`) like every other
 * depth in m; latitude and longitude in degrees, as sent unless derived; else by the name's ending.
 */
function genericUnit(name: string, method: Schemas['Method'] | undefined): Pick<ValueSpec, 'unit' | 'format'> {
  if (name === 'latitude' || name === 'longitude') return { unit: '°', ...(method === 'derived' ? { format: derivedDegrees } : {}) };
  if (/_m$/.test(name)) return { unit: 'm', format: depthText };
  return { unit: GENERIC_UNITS.find(([end]) => end.test(name))?.[1] ?? '' };
}

/** Group, layer and index of a provenance path. */
function placeOf(path: string): Pick<ExtractedValue, 'group' | 'layer' | 'index'> {
  const m = /^(stratigraphy|groundwater|samples|test_results)\[(\d+)\]/.exec(path);
  if (!m) return { group: 'borehole' };
  const i = Number(m[2]);
  if (m[1] === 'stratigraphy') return { group: 'layer', layer: i + 1 };
  if (m[1] === 'groundwater') return { group: 'groundwater' };
  return m[1] === 'samples' ? { group: 'sample', index: i } : { group: 'test', index: i };
}

/** Target Test Results field for a backend test name (case-insensitive), else the name as sent. */
function testField(name: string): { field: string; unit: string } {
  const f = section('testResults').fields.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  return f ? { field: f.name, unit: f.unit === '-' ? '' : f.unit } : { field: name, unit: '' };
}

/* ---------- borehole ---------- */

/**
 * Maps one backend BoreholeRecord to a domain Borehole. Values: one row for every provenance key and
 * for every non-null field the UI shows. The contract allows sparse provenance (review_status counts
 * only values with an entry): a non-null value without one gets a read-only row without method or
 * confidence, can't be patched, and is listed in `unsourced` (no console output here).
 * Throws when the record has no uid.
 */
export function adaptBorehole(rec: WireBorehole): AdaptedBorehole {
  if (!rec || typeof rec.uid !== 'string' || !rec.uid) {
    throw new Error(`Backend borehole record without uid (borehole "${rec?.metadata?.borehole_id ?? '?'}")`);
  }
  const uid = rec.uid;
  const md = rec.metadata;
  const co = md.coordinates ?? {};
  const prov = rec.provenance ?? {};
  const has = (p: string) => Object.prototype.hasOwnProperty.call(prov, p);
  const targets: Record<string, PatchTarget> = {};
  /** Every path a row stands for, patchable or not (lint anchoring). */
  const rowPaths = new Map<string, string[]>();
  const used = new Set<string>();
  const values: ExtractedValue[] = [];
  const unsourced: string[] = [];

  const add = (s: ValueSpec): ExtractedValue | null => {
    const pair = typeof s.path === 'string' ? null : s.path;
    const paths = pair ? [...pair] : [s.path as string];
    const provPaths = paths.filter(has);
    const text = s.text ?? (typeof s.value === 'number' && s.format ? s.format(s.value) : wireText(s.value));
    if (!provPaths.length && !text && !s.shown) return null;
    for (const p of paths) used.add(p);
    const ps = provPaths.map((p) => prov[p]);
    const placed = { group: s.group, ...(s.layer != null ? { layer: s.layer } : {}), ...(s.index != null ? { index: s.index } : {}) };
    let v: ExtractedValue;
    if (!ps.length) {
      if (text) unsourced.push(paths.join(' / '));
      v = {
        key: s.key, field: s.field, label: s.label, ...placed, raw: s.rawFallback ?? '', value: text, unit: s.unit ?? '',
        page: null, box: null, hasProvenance: false, method: null, confidence: null, status: 'unreviewed', state: 'ok',
        aiValue: text, ...s.extra,
      };
    } else {
      // The entry the source is shown from: a spreadsheet cell, else a page; it may be another document's.
      const source = ps.find((p) => p.cell) ?? ps.find((p) => p.page != null) ?? ps[0];
      const cell = source.cell ?? null;
      const page = cell ? null : (source.page ?? null);
      const otherDocument = source.document_id && source.document_id !== rec.document_id ? source.document_id : null;
      const readOnly = s.readOnly ?? (provPaths.includes(CRS_CODE) ? CHOOSE_CRS : undefined);
      const boxes = cell ? [] : ps.filter((p) => p.page === page).map((p) => toBox(p.box)).filter((b): b is Box => b != null);
      const raws = ps.map((p) => p.raw).filter((r): r is string => !!r);
      const confs = ps.map((p) => p.confidence).filter((c): c is number => c != null);
      const statuses = ps.map((p) => toStatus(p.status));
      const status: ReviewStatus = statuses.includes('flagged')
        ? 'flagged'
        : statuses.every((x) => x === 'approved') ? 'approved' : 'unreviewed';
      const state = ps.map((p) => STATES[p.state]).find((x) => x && x !== 'ok') ?? 'ok';
      const methods = ps.map((p) => METHODS[p.method] ?? null);
      const ai = ps.map((p) => p.ai_value);
      const aiText = ai.every((a) => a === undefined)
        ? text
        : ai.map((a) => (typeof a === 'number' && s.format ? s.format(a) : wireText(a))).join(' / ');
      const flag = ps.find((p) => p.flag)?.flag;
      const readings = toReadings(ps.find((p) => p.readings?.length)?.readings);
      v = {
        key: s.key, field: s.field, label: s.label, ...placed,
        raw: raws.join(' / ') || s.rawFallback || '',
        value: text,
        unit: s.unit ?? '',
        page,
        box: boxes.length ? boxes.reduce(unionBox) : null,
        ...(cell ? { cell } : {}),
        ...(otherDocument ? { documentId: otherDocument } : {}),
        ...(readOnly ? { readOnlyReason: readOnly } : {}),
        hasProvenance: true,
        method: methods.includes('Edited') ? 'Edited' : methods[0],
        confidence: confs.length === ps.length && confs.length ? Math.min(...confs) : null,
        status,
        state,
        aiValue: aiText,
        ...(readings ? { readings } : {}),
        ...(flag ? { flag } : {}),
        ...s.extra,
      };
      const current = pair && Array.isArray(s.value) ? ([wireText(s.value[0]), wireText(s.value[1])] as const) : undefined;
      targets[s.key] = {
        paths: provPaths, type: s.type ?? 'string', ...(pair ? { pair, ...(current ? { current } : {}) } : {}),
        ...(readOnly ? { readOnly } : {}), ...(s.sptRaw ? { sptRaw: s.sptRaw } : {}),
      };
    }
    rowPaths.set(s.key, paths);
    values.push(v);
    return v;
  };

  const meta = (key: string, path: string, field: string, label: string, value: unknown, unit = '', type?: PatchValueType, format?: (n: number) => string) =>
    add({ key, path, field, label, group: 'borehole', value, unit, type: type ?? (typeof value === 'number' ? 'number' : 'string'), format });

  // Metadata in review order.
  meta(K.boreholeId, 'metadata.borehole_id', 'BoreholeID', 'Borehole ID', md.borehole_id);
  meta(K.boreholeName, 'metadata.borehole_name', 'BoreholeName', 'Borehole name', md.borehole_name);
  meta(K.project, 'metadata.project_name', 'ProjectName', 'Project', md.project_name);
  meta(K.projectId, 'metadata.project_id', 'ProjectID', 'Project ID', md.project_id);
  meta(K.locationName, 'metadata.location_name', 'LocationName', 'Location', md.location_name);
  meta(K.country, 'metadata.country', EXTRA_FIELDS.country, 'Country', md.country);
  meta(K.client, 'metadata.client', EXTRA_FIELDS.client, 'Client', md.client);
  meta(K.contractor, 'metadata.drilling_contractor', EXTRA_FIELDS.contractor, 'Drilling contractor', md.drilling_contractor);
  meta(K.drillingDate, 'metadata.drilling_date', EXTRA_FIELDS.drillingDate, 'Drilling date', md.drilling_date);
  meta(K.startDate, 'metadata.start_date', 'StartDate', 'Start date', md.start_date);
  meta(K.endDate, 'metadata.end_date', 'EndDate', 'End date', md.end_date);
  meta(K.method, 'metadata.drilling_method', EXTRA_FIELDS.drillingMethod, 'Drilling method', md.drilling_method);
  meta(K.finalDepth, 'metadata.borehole_depth_m', 'BoreholeDepth', 'Final depth', md.borehole_depth_m, 'm', 'number', depthText);
  meta(K.boreholeLength, 'metadata.borehole_length_m', 'BoreholeLength', 'Borehole length', md.borehole_length_m, 'm', 'number', depthText);
  meta(K.inclination, 'metadata.inclination_deg', EXTRA_FIELDS.inclination, 'Inclination', md.inclination_deg, '°', 'number');
  // The unit is m; the datum as printed stays in the metadata and in the note (it may name the unit too: "m s.n.m.").
  add({
    key: K.elevation, path: 'metadata.surface_elevation_mASL', field: 'Surface Elevation', label: 'Surface elevation', group: 'borehole',
    value: md.surface_elevation_mASL, unit: 'm', type: 'number', format: depthText,
    ...(md.elevation_datum ? { extra: { note: `datum: ${md.elevation_datum}` } } : {}),
  });
  meta(K.elevationDatum, 'metadata.elevation_datum', EXTRA_FIELDS.elevationDatum, 'Elevation datum', md.elevation_datum);
  meta(K.depthOrigin, 'metadata.depth_origin', EXTRA_FIELDS.depthOrigin, 'Depth origin', md.depth_origin);

  // X / Y: the pair the provenance has (local, else geographic); without provenance, the pair that has values.
  const LOCAL = ['metadata.coordinates.local_x', 'metadata.coordinates.local_y'] as const;
  const GEO = ['metadata.coordinates.longitude', 'metadata.coordinates.latitude'] as const;
  const localVals = [co.local_x ?? null, co.local_y ?? null] as const;
  const geoVals = [co.longitude ?? null, co.latitude ?? null] as const;
  const anyOf = (vs: readonly (number | null)[]) => vs.some((x) => x != null);
  const xyPair = LOCAL.some(has) ? LOCAL : GEO.some(has) ? GEO : anyOf(localVals) ? LOCAL : GEO;
  const xyVals = xyPair === LOCAL ? localVals : geoVals;
  add({
    key: K.xy, path: xyPair, field: multiField('X-Coordinate', 'Y-Coordinate'), label: 'X / Y', group: 'borehole',
    value: xyVals, text: anyOf(xyVals) ? xyVals.map((x) => (x == null ? '' : String(x))).join(' / ') : '', type: 'number',
  });
  const crsPath = !has('metadata.coordinates.coordinate_system') && has('metadata.coordinates.crs_code')
    ? 'metadata.coordinates.crs_code'
    : 'metadata.coordinates.coordinate_system';
  const crsRow = meta(K.crs, crsPath, 'CoordinateSystem', 'CRS', crsPath.endsWith('crs_code') ? co.crs_code : co.coordinate_system);
  if (crsRow) crsRow.kind = 'crs';
  meta(K.rockHead, 'rock_head_m', EXTRA_FIELDS.rockHead, 'Rock head', rec.rock_head_m, 'm', 'number', depthText);
  meta(K.casing, 'metadata.casing_info', EXTRA_FIELDS.casing, 'Casing', md.casing_info);
  meta(K.notes, 'metadata.notes', 'Notes', 'Remarks', md.notes);

  const groundwater = adaptGroundwater(rec, add);
  const layers = (rec.stratigraphy ?? []).map((l, i) => adaptLayer(l, i, add, has));
  const samples = adaptSamples(rec, add);
  const testResults = adaptTests(rec, add);

  // Every other provenance key gets a row too, so nothing the backend tracks is hidden from review.
  for (const path of Object.keys(prov)) {
    if (used.has(path)) continue;
    const wire = valueAt(rec, path);
    const name = /(\w+)$/.exec(path)?.[1] ?? path;
    // An N tracked without any SPT data (e.g. illegible) follows the SPT row's rules for N.
    const sptRaw = name === 'spt_n_value' && has(path.replace(/spt_n_value$/, 'spt_raw')) ? path.replace(/spt_n_value$/, 'spt_raw') : undefined;
    const type: PatchValueType = name === 'spt_n_value' ? 'spt'
      : typeof wire === 'number' || (wire == null && NUMERIC_FIELD.test(name)) ? 'number'
        : typeof wire === 'boolean' || name.startsWith('is_') || name === 'spt_refusal' ? 'boolean' : 'string';
    add({
      key: path, path, field: name, label: GENERIC_LABELS[name] ?? name.replace(/_/g, ' '), ...placeOf(path),
      value: wire, type, shown: true, ...genericUnit(name, prov[path].method), ...(sptRaw ? { sptRaw } : {}),
    });
  }

  // Every backend finding lands on a review row; then SPT increments that don't add up, unless linted already.
  for (const l of rec.lint ?? []) {
    const key = lintAnchor(l.path, rowPaths);
    const v = key ? values.find((x) => x.key === key) : undefined;
    if (v) v.lint = mergeLint(v.lint, { severity: l.severity, message: l.message });
  }
  for (const v of values) {
    const lint = v.spt && !v.lint ? sptLint(v.spt) : undefined;
    if (lint) v.lint = lint;
  }

  // Review order: borehole fields, groundwater, layers, samples, tests; by layer / index within a group.
  const order = new Map(values.map((v, i) => [v, i]));
  values.sort(
    (a, b) =>
      GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
      (a.layer ?? a.index ?? 0) - (b.layer ?? b.index ?? 0) ||
      (order.get(a) as number) - (order.get(b) as number),
  );

  const provPages = [...new Set(Object.values(prov).map((p) => p.page).filter((p): p is number => p != null))].sort((a, b) => a - b);
  const pages = rec.pages?.length ? rec.pages : provPages;
  const finalDepth = md.borehole_depth_m ?? null;
  const boreholeMeta: BoreholeMeta = {
    aliases: md.aliases ?? [],
    elevationDatum: md.elevation_datum ?? null,
    depthOrigin: md.depth_origin ?? null,
    depthSource: md.borehole_depth_source ?? null,
    xRaw: co.x_raw ?? null,
    yRaw: co.y_raw ?? null,
    axisLabelsRaw: co.axis_labels_raw ?? null,
    localX: co.local_x ?? null,
    localY: co.local_y ?? null,
  };

  return {
    targets,
    unsourced,
    borehole: {
      uid,
      id: md.borehole_id,
      documentId: rec.document_id ?? null,
      sourceFile: rec.source_file ?? '',
      project: md.project_name ?? '',
      revision: rec.revision,
      reviewStatus: rec.review_status,
      openClarifications: rec.open_clarifications ?? 0,
      lat: co.latitude ?? null,
      lng: co.longitude ?? null,
      onMap: rec.plotted,
      unplottedReason: rec.unplotted_reason ?? null,
      // Unknown stays unknown: the log bottom only bounds the drawing, it is not the final depth.
      finalDepth,
      logBottom: layers.length ? layers[layers.length - 1].to : (finalDepth ?? 0),
      crs: { name: co.coordinate_system ?? null, code: co.crs_code ?? null, status: rec.crs_status, label: co.crs_label ?? null },
      meta: boreholeMeta,
      layers,
      groundwater,
      samples,
      testResults,
      rockHead: rec.rock_head_m ?? null,
      values,
      pages,
      // A record read only from a spreadsheet has no page: no primary page, never an invented page 1.
      primaryPage: pages[0] ?? null,
    },
  };
}

type Add = (s: ValueSpec) => ExtractedValue | null;

/**
 * The review row a backend lint finding is shown on. Every finding gets one, so none is lost: its own
 * value, else (for a layer's start depth) the bottom of the layer above, any row of the same layer,
 * reading, sample or test, the X / Y or CRS row for coordinates, and finally the borehole ID.
 */
function lintAnchor(path: string, rowPaths: Map<string, string[]>): string | null {
  const keys = [...rowPaths.keys()];
  const exact = keys.find((k) => rowPaths.get(k)?.includes(path));
  if (exact) return exact;
  const layer = /^stratigraphy\[(\d+)\]\.?(\w*)/.exec(path);
  if (layer) {
    const i = Number(layer[1]);
    const n = layer[2] === 'depth_from_m' && i > 0 ? i : i + 1;
    if (rowPaths.has(K.bottom(n))) return K.bottom(n);
  }
  const item = /^(stratigraphy|groundwater|samples|test_results)\[\d+\]/.exec(path);
  if (item) {
    const same = keys.find((k) => rowPaths.get(k)?.some((p) => p.startsWith(`${item[0]}.`)));
    if (same) return same;
  }
  if (path.startsWith('metadata.coordinates')) {
    if (rowPaths.has(K.xy)) return K.xy;
    if (rowPaths.has(K.crs)) return K.crs;
  }
  return rowPaths.has(K.boreholeId) ? K.boreholeId : (keys[0] ?? null);
}

/** The SPT row's path: the first SPT field the provenance has (N, raw text, refusal flag), else N. */
function sptPath(base: string, has: (p: string) => boolean): string {
  return [`${base}.spt_n_value`, `${base}.spt_raw`, `${base}.spt_refusal`].find(has) ?? `${base}.spt_n_value`;
}

/** Why the English lithology can't be edited on a row that stands for the printed description. */
const ENGLISH_OVER_PRINTED =
  'Shown in English, but the backend tracks only the printed description of this layer: an edit here would overwrite the printed text.';

function adaptLayer(l: WireLayer, i: number, add: Add, has: (p: string) => boolean): Layer {
  const n = i + 1;
  const base = `stratigraphy[${i}]`;
  const at = { group: 'layer' as const, layer: n };
  const din = l.din4023_code ?? null;
  add({ ...at, key: K.bottom(n), path: `${base}.depth_to_m`, field: EXTRA_FIELDS.depthTo, label: 'Bottom depth',
    value: l.depth_to_m, format: depthText, unit: 'm', type: 'number' });
  // The lithology row stands for english_lithology when the backend tracks it, else for the printed
  // description (the seed tracks a layer's text there). It shows the English lithology when there is one.
  const desc = `${base}.original_description`;
  const onDesc = !has(`${base}.english_lithology`) && has(desc);
  const english = l.english_lithology ?? null;
  const lith = add({
    ...at, key: K.lithology(n), path: onDesc ? desc : `${base}.english_lithology`, field: 'Lithology/SoilName', label: 'Lithology',
    value: english ?? (onDesc ? l.original_description : null), rawFallback: l.original_description ?? '',
    ...(onDesc && english != null ? { readOnly: ENGLISH_OVER_PRINTED } : {}),
    // The English text has no entry of its own here, so it is its own machine value.
    extra: { kind: 'lithology', ...(din ? { din } : {}), ...(onDesc && english != null ? { aiValue: english } : {}) },
  });
  const text = (key: string, wire: string, field: string, label: string, value: unknown) =>
    add({ ...at, key, path: `${base}.${wire}`, field, label, value });
  text(K.strat(n), 'stratigraphic_name', 'StratigraphicName', 'Stratigraphy', l.stratigraphic_name);
  text(K.soilUnit(n), 'engineering_soil_unit', 'EngineeringSoilUnit', 'Engineering soil unit', l.engineering_soil_unit);
  text(K.age(n), 'geologic_age', 'GeologicAge', 'Geologic age', l.geologic_age);
  text(K.colour(n), 'colour', EXTRA_FIELDS.colour, 'Colour', l.colour);
  text(K.consistency(n), 'consistency_density', EXTRA_FIELDS.consistency, 'Consistency', l.consistency_density);
  text(K.moisture(n), 'moisture', EXTRA_FIELDS.moisture, 'Moisture', l.moisture);
  text(K.weathering(n), 'weathering', EXTRA_FIELDS.weathering, 'Weathering', l.weathering);
  add({ ...at, key: K.core(n), path: `${base}.is_core`, field: 'Core', label: 'Core', value: l.is_core, type: 'boolean' });

  const spt = adaptSpt(l);
  if (spt) {
    const path = sptPath(base, has);
    const onN = path.endsWith('spt_n_value');
    // On N, a text that is no whole number (a refusal) can only go to the printed SPT text, when tracked.
    const sptRaw = onN && has(`${base}.spt_raw`) ? `${base}.spt_raw` : undefined;
    // The increment lint is added once the backend's own findings are attached (adaptBorehole).
    add({
      ...at, key: K.spt(n), path, field: 'SPT', label: spt.depth == null ? 'SPT (depth not stated)' : `SPT @ ${spt.depth.toFixed(2)} m`,
      value: null, text: formatSpt(spt), rawFallback: spt.raw, shown: true,
      type: onN ? 'spt' : path.endsWith('spt_refusal') ? 'boolean' : 'string', ...(sptRaw ? { sptRaw } : {}),
      extra: { kind: 'spt', spt, refusal: spt.refusal },
    });
  }
  add({ ...at, key: K.tcr(n), path: `${base}.core_recovery_pct`, field: 'TotalCoreRecovery', label: 'TCR', value: l.core_recovery_pct, unit: '%', type: 'number' });
  add({ ...at, key: K.rqd(n), path: `${base}.rqd_pct`, field: 'RQD', label: 'RQD', value: l.rqd_pct, unit: '%', type: 'number' });
  // Layer UCS: a layer value named after the Test Results field, so exports can place it with the layer's depth.
  add({ ...at, key: K.ucs(n), path: `${base}.ucs_mpa`, field: 'UCS', label: 'UCS', value: l.ucs_mpa, unit: 'MPa', type: 'number' });

  return {
    n,
    from: l.depth_from_m,
    to: l.depth_to_m,
    lithology: l.english_lithology ?? '',
    lithologyAsPrinted: l.original_description ?? '',
    din,
    dinNotation: l.din4023_notation ?? null,
    stratigraphicName: l.stratigraphic_name ?? null,
    engineeringSoilUnit: l.engineering_soil_unit ?? null,
    geologicAge: l.geologic_age ?? null,
    colour: l.colour ?? null,
    consistency: l.consistency_density ?? null,
    moisture: l.moisture ?? null,
    weathering: l.weathering ?? null,
    isCore: l.is_core ?? null,
    method: lith?.method ?? null,
    confidence: lith?.confidence ?? null,
    ...(spt ? { spt } : {}),
    ...(l.core_recovery_pct != null ? { tcr: l.core_recovery_pct } : {}),
    ...(l.rqd_pct != null ? { rqd: l.rqd_pct } : {}),
  };
}

/** The layer's SPT as the source states it; the depth stays null when not stated. */
function adaptSpt(l: WireLayer): Spt | null {
  const inc = l.spt_increments?.length ? l.spt_increments : undefined;
  if (l.spt_raw == null && l.spt_n_value == null && !l.spt_refusal && !inc) return null;
  const refusal = !!l.spt_refusal;
  return {
    raw: l.spt_raw ?? '',
    depth: l.spt_depth_m ?? null,
    refusal,
    ...(inc ? { increments: inc } : {}),
    ...(!refusal && l.spt_n_value != null ? { n: l.spt_n_value } : {}),
    ...(refusal && inc ? { blows: inc[0] } : {}),
    ...(l.spt_penetration_cm != null ? { penetrationCm: l.spt_penetration_cm } : {}),
    ...(l.spt_increment_mm != null ? { incrementMm: l.spt_increment_mm } : {}),
  };
}

const GW_TYPES: readonly GroundwaterType[] = ['strike', 'rest', 'standpipe', 'other'];
const GW_VALUE_LABEL: Record<GroundwaterType, string> = {
  strike: 'GW strike', rest: 'GW rest level', standpipe: 'GW standpipe', other: 'GW reading',
};

/**
 * Every groundwater reading, keyed by its index in the backend list (depth may be null). The depth is
 * "m bgl" only when the record states depths below ground; any other or no stated origin is plain "m"
 * (Detail states the origin separately).
 */
function adaptGroundwater(rec: WireBorehole, add: Add): GroundwaterReading[] {
  const list = rec.groundwater ?? [];
  const unit = rec.metadata.depth_origin === 'ground' ? 'm bgl' : 'm';
  return list.map((g, i) => {
    const type = GW_TYPES.find((t) => t === g.type) ?? 'other';
    // Several readings of one type: tell them apart by date, else by count ("GW rest level 2").
    const same = list.filter((x) => x.type === g.type);
    const suffix = same.length < 2 ? '' : g.date ? ` (${g.date})` : ` ${same.indexOf(g) + 1}`;
    const key = K.gw(i);
    const label = GW_VALUE_LABEL[type] + suffix;
    add({ key, path: `groundwater[${i}].depth_m`, field: 'Groundwaterlevel', label, group: 'groundwater',
      value: g.depth_m, format: depthText, unit, type: 'number', rawFallback: g.raw ?? '' });
    add({ key: `groundwater[${i}].elevation_m`, path: `groundwater[${i}].elevation_m`, field: 'elevation_m',
      label: `${label} elevation`, group: 'groundwater', value: g.elevation_m, format: depthText, unit: 'm', type: 'number', rawFallback: g.raw ?? '' });
    return { type, depth: g.depth_m ?? null, elevation: g.elevation_m ?? null, date: g.date ?? null, raw: g.raw ?? null, key };
  });
}

/** Samples: name and depth become SampleName / SampleDepth values (group "sample"). */
function adaptSamples(rec: WireBorehole, add: Add): Sample[] {
  return (rec.samples ?? []).map((s, i) => {
    const at = { group: 'sample' as const, index: i };
    add({ ...at, key: K.sampleName(i), path: `samples[${i}].name`, field: 'SampleName', label: 'Sample', value: s.name });
    add({ ...at, key: K.sampleDepth(i), path: `samples[${i}].depth_from_m`, field: 'SampleDepth', label: `Sample ${s.name} depth`,
      value: s.depth_from_m, format: depthText, unit: 'm', type: 'number' });
    add({ ...at, key: `samples[${i}].depth_to_m`, path: `samples[${i}].depth_to_m`, field: EXTRA_FIELDS.sampleDepthTo,
      label: `Sample ${s.name} depth to`, value: s.depth_to_m, format: depthText, unit: 'm', type: 'number' });
    return { name: s.name, typeCode: s.type_code ?? null, from: s.depth_from_m ?? null, to: s.depth_to_m ?? null, key: K.sampleName(i) };
  });
}

/** Test results: one value each, named after the target Test Results field (group "test"). */
function adaptTests(rec: WireBorehole, add: Add): TestResult[] {
  return (rec.test_results ?? []).map((t, i) => {
    const { field, unit } = testField(t.name);
    add({
      group: 'test', index: i, key: K.test(i), path: `test_results[${i}].value`, field, label: t.name,
      value: t.value, unit: t.unit ?? unit, type: 'number',
      ...(t.qualifier ? { extra: { note: `qualifier as printed: ${t.qualifier}` } } : {}),
    });
    return {
      name: t.name, value: t.value ?? null, qualifier: t.qualifier ?? null, unit: t.unit ?? (unit || null),
      sampleName: t.sample_name ?? null, depth: t.depth_m ?? null, key: K.test(i),
    };
  });
}

/** Lint findings of a document for the Completeness panel: every linted value of its boreholes. */
export function documentLint(boreholes: Borehole[], documentId: string): LintFinding[] {
  return boreholes
    .filter((b) => b.documentId === documentId)
    .flatMap((b) => b.values.flatMap((v) => (v.lint ? [{ severity: v.lint.severity, boreholeId: b.id, message: v.lint.message }] : [])));
}

/* ---------- documents ---------- */

const STEP: Record<DocumentStatus, DocumentStep> = {
  queued: 0, classifying: 0, extracting: 1, needs_review: 2, done: 3, failed: 0,
};

/** The UI step of a document status. */
export function stepOf(status: DocumentStatus): DocumentStep {
  return STEP[status] ?? 0;
}

/**
 * The UI step each pipeline stage belongs to (contract 1.2.0 `failed_stage`, the same names as the
 * job.failed event's `stage`): triage and page classification are "classifying", everything after
 * them (OCR, extraction, the second reading and the spreadsheet stages) is "extracting".
 */
const STAGE_STEP: Record<string, DocumentStep> = {
  triage: 0, classify: 0, ocr: 1, extract: 1, reread: 1, sheet_read: 1, sheet_map: 1, sheet_extract: 1,
};

/** The UI step a failed pipeline stage belongs to; null for a stage this client does not know. */
export function stageStep(stage: string | null | undefined): DocumentStep | null {
  return stage != null && Object.hasOwn(STAGE_STEP, stage) ? STAGE_STEP[stage] : null;
}

/**
 * The UI step of a document. A failed one is placed by its failed stage (1.2.0); without a known
 * stage by its progress: failed during extraction (step 1) once every page was classified, else
 * during classification (step 0).
 */
function documentStep(d: WireDocument): DocumentStep {
  if (d.status !== 'failed') return stepOf(d.status);
  const byStage = stageStep(d.failed_stage);
  if (byStage !== null) return byStage;
  const pr = d.progress;
  return pr && pr.pages_total > 0 && pr.pages_classified >= pr.pages_total ? 1 : 0;
}

/** True once the backend has stopped working on a document. */
export function isTerminal(status: DocumentStatus): boolean {
  return status === 'needs_review' || status === 'done' || status === 'failed';
}

/** One classified page. A listed page of type unknown without a role is not classified yet. */
function adaptPage(p: WirePage): DocumentPage {
  if (p.type === 'unknown' && p.role == null) return placeholderPage(p.n);
  const dup = p.duplicate_of;
  return {
    n: p.n,
    type: p.type,
    role: p.role ?? null,
    used: p.used,
    unusedReason: p.unused_reason ?? null,
    boreholeIds: p.borehole_ids ?? [],
    sheetLabel: p.sheet_label ?? null,
    handwriting: p.handwriting ?? null,
    language: p.language ?? null,
    ocr: p.ocr ?? null,
    duplicateOf: dup?.document_id != null && dup.n != null ? { documentId: dup.document_id, n: dup.n } : null,
    classified: true,
  };
}

/**
 * Maps a backend document to a DocumentSummary. Pages run 1..page count; pages the backend hasn't
 * classified are placeholders. The caller fills the project (when the document has none), the
 * review borehole and the completeness lint from the document's boreholes.
 */
export function adaptDocument(d: WireDocument): DocumentSummary {
  const listed = d.pages ?? [];
  const count = Math.max(d.page_count ?? 0, ...listed.map((p) => p.n));
  const byN = new Map(listed.map((p) => [p.n, p]));
  const pages = Array.from({ length: count }, (_, i) => {
    const p = byN.get(i + 1);
    return p ? adaptPage(p) : placeholderPage(i + 1);
  });
  const c = d.completeness;
  const pr = d.progress;
  return {
    id: d.document_id,
    name: d.file_name,
    project: d.project ?? '',
    status: d.status,
    pages,
    step: documentStep(d),
    progress: pr
      ? {
          pagesTotal: pr.pages_total, pagesClassified: pr.pages_classified, pagesOcrTotal: pr.pages_ocr_total,
          pagesOcrDone: pr.pages_ocr_done, boreholesExtracted: pr.boreholes_extracted,
        }
      : null,
    counts: d.found ?? null,
    completeness: c
      ? { listed: c.expected_ids.length, idPrefix: '', missing: c.missing, unexpected: c.unexpected, lint: [], expectedIds: c.expected_ids }
      : null,
    reviewBoreholeUid: null,
    openClarifications: d.open_clarifications ?? 0,
    duplicateOf: d.duplicate_of ?? null,
    error: d.status === 'failed' ? d.error || 'Extraction failed' : null,
    failedStage: d.status === 'failed' && isText(d.failed_stage) ? d.failed_stage : null,
    // Shown as they are; the contract sends them only for a document in review or done.
    warnings: d.status === 'needs_review' || d.status === 'done' ? (d.warnings ?? []).filter(isText) : [],
  };
}

/** Maps backend CRS candidates; absent verdict, score or note stay null, absent swap_axes is false. */
export function adaptCrsCandidates(list: WireCrsCandidate[]): CrsCandidate[] {
  return list.map((c) => ({
    name: c.label,
    code: c.crs,
    note: c.note ?? null,
    score: c.score ?? null,
    verdict: c.verdict ?? null,
    swapAxes: c.swap_axes ?? false,
    points: c.points.map((p) => ({ uid: p.uid, lat: p.lat, lng: p.lon })),
  }));
}

/* ---------- live events ---------- */

/** The named event types of GET /events (contracts/realtime-and-chat.md section 1), one listener each. */
export const LIVE_EVENT_TYPES = [
  'document.updated', 'document.deleted', 'borehole.created', 'borehole.updated',
  'clarification.created', 'clarification.resolved', 'job.failed',
] as const satisfies readonly (keyof WireEventData)[];

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

/** True for an event type of section 1. */
export function isLiveEventType(type: string): type is LiveEventType {
  return (LIVE_EVENT_TYPES as readonly string[]).includes(type);
}

const DOCUMENT_STATUSES = new Set<string>(Object.keys(STEP));

type Fields = Record<string, unknown>;
const isFields = (x: unknown): x is Fields => x != null && typeof x === 'object' && !Array.isArray(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x !== '';
/** A text without its outer blanks; null for a blank or a non-text. */
const trimmed = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);
const isRevision = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

/**
 * Maps the parsed `data` of one event to a LiveEvent. `summarise` turns the full Document of
 * `document.updated` into the summary the loads produce (the API source passes its own, which adds
 * what the document's boreholes say); by default the plain adapted document. Null for an unknown
 * type or data without the fields the contract requires: the caller logs and ignores it.
 */
export function adaptLiveEvent(
  type: string,
  data: unknown,
  summarise: (d: WireDocument) => DocumentSummary = adaptDocument,
): LiveEvent | null {
  if (!isLiveEventType(type) || !isFields(data)) return null;
  switch (type) {
    case 'document.updated':
      if (!isText(data.document_id) || typeof data.file_name !== 'string' || !DOCUMENT_STATUSES.has(String(data.status))) return null;
      return { type, document: summarise(data as unknown as WireDocument) };
    case 'document.deleted':
      return isText(data.document_id) ? { type, documentId: data.document_id } : null;
    case 'borehole.created':
      if (!isText(data.uid) || !isText(data.document_id) || !isRevision(data.revision) || typeof data.plotted !== 'boolean') return null;
      return { type, uid: data.uid, documentId: data.document_id, revision: data.revision, plotted: data.plotted };
    case 'borehole.updated':
      return isText(data.uid) && isRevision(data.revision) ? { type, uid: data.uid, revision: data.revision } : null;
    case 'clarification.created': {
      // The whole question (contract Clarification); one this client can't show is no event.
      const clarification = adaptClarification(data);
      return clarification ? { type, clarification } : null;
    }
    case 'clarification.resolved': {
      if (!isText(data.clarification_id) || (data.status !== 'answered' && data.status !== 'skipped')) return null;
      // 1.2.0 names the question's document and boreholes; an older server sends only the id.
      const uids = Array.isArray(data.borehole_uids) ? data.borehole_uids.filter(isText) : null;
      return {
        type, clarificationId: data.clarification_id, status: data.status,
        ...(isText(data.document_id) ? { documentId: data.document_id, boreholeUids: uids ?? [] } : {}),
      };
    }
    case 'job.failed':
      if (!isText(data.document_id) || typeof data.stage !== 'string' || typeof data.detail !== 'string' || typeof data.retryable !== 'boolean') {
        return null;
      }
      return { type, documentId: data.document_id, stage: data.stage, detail: data.detail, retryable: data.retryable };
  }
}

/* ---------- left-out items ---------- */

/**
 * One console.info for a batch (a list answer) of items this client can't represent and leaves out,
 * with a few examples; nothing when every item was kept. Never a value guessed in their place.
 */
function reportLeftOut(what: string, reasons: string[]): void {
  if (!reasons.length) return;
  const more = reasons.length > 3 ? ', …' : '';
  console.info(`Left ${reasons.length} ${what} out (the server sent what this client can't show): ${reasons.slice(0, 3).join('; ')}${more}`);
}

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** [min_lon, min_lat, max_lon, max_lat] when the wire value is four numbers, else null. */
function toBbox(b: unknown): [number, number, number, number] | null {
  return Array.isArray(b) && b.length === 4 && b.every(isNumber) ? [b[0], b[1], b[2], b[3]] : null;
}

/* ---------- map features (GET /map/boreholes.geojson, GET /result-sets/{id}/geojson) ---------- */

const REVIEW_STATUSES: readonly BoreholeReviewStatus[] = ['unreviewed', 'in_review', 'approved'];
const CRS_STATUSES: readonly CrsStatus[] = ['stated', 'inferred', 'confirmed', 'unknown'];
const isReviewStatus = (x: unknown): x is BoreholeReviewStatus => (REVIEW_STATUSES as readonly unknown[]).includes(x);
const isCrsStatus = (x: unknown): x is CrsStatus => (CRS_STATUSES as readonly unknown[]).includes(x);

/** One feature as a MapFeature, or why it is left out. */
function adaptFeature(f: WireFeature): MapFeature | string {
  const p: Partial<WireFeature['properties']> = isFields(f?.properties) ? f.properties : {};
  const uid = isText(p.uid) ? p.uid : isText(f?.id) ? f.id : null;
  const name = `${uid ?? '?'}${typeof p.borehole_id === 'string' ? ` (${p.borehole_id})` : ''}`;
  if (!uid) return 'a feature without uid';
  if (typeof p.borehole_id !== 'string') return `${name}: no borehole_id`;
  if (!isReviewStatus(p.review_status)) return `${name}: review_status "${String(p.review_status)}"`;
  if (!isCrsStatus(p.crs_status)) return `${name}: crs_status "${String(p.crs_status)}"`;
  const c = f.geometry?.coordinates;
  const [lng, lat] = Array.isArray(c) ? c : [];
  // [lon, lat] in WGS84; anything else is never placed (no 0, no (0, 0)).
  if (!isNumber(lng) || !isNumber(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return `${name}: no usable [lon, lat]`;
  const open = isNumber(p.open_clarifications) ? p.open_clarifications : 0;
  return {
    uid,
    id: p.borehole_id,
    project: p.project_name ?? null,
    documentId: isText(p.document_id) ? p.document_id : null,
    lat,
    lng,
    depth: isNumber(p.borehole_depth_m) ? p.borehole_depth_m : null,
    reviewStatus: p.review_status,
    crsStatus: p.crs_status,
    // 1.2.0: the stated or confirmed system; null (or absent from an older server) when there is none.
    crsCode: trimmed(p.crs_code),
    crsLabel: trimmed(p.crs_label),
    revision: isRevision(p.revision) ? p.revision : null,
    // The contract's attention covers flags, lint errors and unresolved questions; without the flag
    // only the questions are known.
    attention: typeof p.attention === 'boolean' ? p.attention : open > 0,
    openClarifications: open,
  };
}

/**
 * The light map layer as MapFeatures, in the server's order. A feature with an unknown review or CRS
 * status, without a uid or without a usable [lon, lat] is left out (one console.info per call).
 */
export function adaptFeatures(fc: WireFeatureCollection): MapFeature[] {
  const out: MapFeature[] = [];
  const left: string[] = [];
  for (const f of fc?.features ?? []) {
    const r = adaptFeature(f);
    if (typeof r === 'string') left.push(r);
    else out.push(r);
  }
  reportLeftOut(left.length === 1 ? 'map feature' : 'map features', left);
  return out;
}

/* ---------- filters and areas (BoreholeFilter, AreaBbox, AreaPolygon, AreaCircle) ---------- */

/** An area drawn on the map as the contract sends it. */
export function toWireArea(a: Area): WireArea {
  switch (a.type) {
    case 'bbox':
      return { type: 'bbox', bbox: [...a.bbox] };
    case 'polygon':
      // The generated type of a GeoJSON object is an empty record; the polygon goes as it is.
      return { type: 'polygon', polygon: structuredClone(a.polygon) as unknown as Schemas['AreaPolygon']['polygon'] };
    case 'circle':
      return { type: 'circle', center: [...a.center], radius_m: a.radiusM };
  }
}

/** A position [lon, lat] of a GeoJSON ring. */
const isPosition = (p: unknown): p is number[] => Array.isArray(p) && p.length >= 2 && isNumber(p[0]) && isNumber(p[1]);

/** An area as sent (a ResultSet's echo, a filter's area), or null when it isn't one the contract defines. */
export function adaptArea(x: unknown): Area | null {
  if (!isFields(x)) return null;
  if (x.type === 'bbox') {
    const bbox = toBbox(x.bbox);
    return bbox ? { type: 'bbox', bbox } : null;
  }
  if (x.type === 'circle') {
    const c = x.center;
    if (!isPosition(c) || c.length !== 2 || !isNumber(x.radius_m) || x.radius_m <= 0) return null;
    return { type: 'circle', center: [c[0], c[1]], radiusM: x.radius_m };
  }
  if (x.type === 'polygon' && isFields(x.polygon) && x.polygon.type === 'Polygon') {
    const rings = x.polygon.coordinates;
    if (!Array.isArray(rings) || !rings.length || !rings.every((r) => Array.isArray(r) && r.length >= 3 && r.every(isPosition))) return null;
    return { type: 'polygon', polygon: { type: 'Polygon', coordinates: (rings as number[][][]).map((r) => r.map((p) => [...p])) } };
  }
  return null;
}

/** Text of a filter field, or null when blank. */
const filterText = (s: string | null): string | null => (s != null && s.trim() ? s.trim() : null);

/**
 * A filter as the contract's BoreholeFilter: unset fields (null, blank text, empty lists) are left
 * out; include_unreviewed is always sent.
 */
export function toWireFilter(f: BoreholeFilter): WireFilter {
  const out: WireFilter = { include_unreviewed: f.includeUnreviewed };
  const search = filterText(f.search);
  const country = filterText(f.country);
  const project = filterText(f.project);
  const documentId = filterText(f.documentId);
  if (search != null) out.search = search;
  if (country != null) out.country = country;
  if (project != null) out.project = project;
  if (documentId != null) out.document_id = documentId;
  if (f.minDepth != null) out.min_depth_m = f.minDepth;
  if (f.maxDepth != null) out.max_depth_m = f.maxDepth;
  if (f.dinCodes.length) out.din4023_codes = [...f.dinCodes];
  if (f.lithologyMinDepth != null) out.lithology_min_depth_m = f.lithologyMinDepth;
  if (f.hasSpt != null) out.has_spt = f.hasSpt;
  if (f.hasGroundwater != null) out.has_groundwater = f.hasGroundwater;
  if (f.reviewStatus.length) out.review_status = [...f.reviewStatus];
  if (f.area) out.area = toWireArea(f.area);
  return out;
}

/** A filter as sent (a result set's definition): absent fields are unset; include_unreviewed defaults to false (contract). */
export function adaptFilter(w: WireFilter | null | undefined): BoreholeFilter {
  const f: Partial<WireFilter> = w ?? {};
  return {
    search: f.search ?? null,
    country: f.country ?? null,
    project: f.project ?? null,
    documentId: f.document_id ?? null,
    minDepth: f.min_depth_m ?? null,
    maxDepth: f.max_depth_m ?? null,
    dinCodes: [...(f.din4023_codes ?? [])],
    lithologyMinDepth: f.lithology_min_depth_m ?? null,
    hasSpt: f.has_spt ?? null,
    hasGroundwater: f.has_groundwater ?? null,
    reviewStatus: (f.review_status ?? []).filter(isReviewStatus),
    includeUnreviewed: f.include_unreviewed ?? false,
    area: adaptArea(f.area),
  };
}

/* ---------- result sets ---------- */

/**
 * A stored result set. An absent excluded count stays null; the echoed area is the definition's when
 * the answer has no `area` field.
 */
export function adaptResultSet(rs: WireResultSet): ResultSet {
  const definition = adaptFilter(rs.definition);
  return {
    id: rs.result_set_id,
    count: rs.count,
    locatedCount: rs.located_count,
    unlocatedCount: rs.unlocated_count,
    excludedUnreviewed: isNumber(rs.excluded_unreviewed) ? rs.excluded_unreviewed : null,
    uids: [...rs.uids],
    bbox: toBbox(rs.bbox),
    area: rs.area !== undefined ? adaptArea(rs.area) : definition.area,
    definition,
    createdAt: rs.created_at,
  };
}

/* ---------- planned lines (contract 1.3.0 Alignment, AlignmentResult) ---------- */

/** [lng, lat] of a GeoJSON position, or null when it isn't one. */
const lngLat = (p: unknown): [number, number] | null => (isPosition(p) ? [p[0], p[1]] : null);

/** A GeoJSON line's positions (positions that aren't one are left out). */
function linePositions(x: unknown): [number, number][] {
  return Array.isArray(x) ? x.map(lngLat).filter((p): p is [number, number] => p !== null) : [];
}

/** The parts of a GeoJSON LineString or MultiLineString, each with at least two positions. */
export function lineParts(geometry: { type?: unknown; coordinates?: unknown } | null | undefined): [number, number][][] {
  if (!geometry) return [];
  const lines = geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates) ? geometry.coordinates : [geometry.coordinates];
  return lines.map(linePositions).filter((part) => part.length >= 2);
}

/** The polygons of a GeoJSON Polygon or MultiPolygon, each a list of rings of [lng, lat]. */
export function polygonsOf(geometry: { type?: unknown; coordinates?: unknown } | null | undefined): [number, number][][][] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : geometry.type === 'Polygon' ? [geometry.coordinates] : [];
  return polygons
    .map((rings: unknown) => (Array.isArray(rings) ? rings.map(linePositions).filter((ring) => ring.length >= 3) : []))
    .filter((rings) => rings.length > 0);
}

/** [min_lon, min_lat, max_lon, max_lat] of some positions; null without any. */
export function positionsBbox(points: readonly [number, number][]): [number, number, number, number] | null {
  if (!points.length) return null;
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** A stored planned line. */
export function adaptAlignment(w: WireAlignment): Alignment {
  const parts = lineParts(w.geometry);
  return {
    id: w.alignment_id,
    name: w.name,
    fileName: w.file_name,
    format: w.format,
    sourceCrs: w.source_crs,
    parts,
    lengthM: w.length_m,
    vertexCount: w.vertex_count,
    partCount: w.part_count,
    bbox: toBbox(w.bbox) ?? positionsBbox(parts.flat()),
    bufferM: w.buffer_m,
    createdAt: w.created_at,
  };
}

/** The planned lines of a list, newest first as the server sends them. */
export function adaptAlignments(list: WireAlignmentList): Alignment[] {
  return list.alignments.map(adaptAlignment);
}

function adaptHit(h: WireAlignmentHit): AlignmentHit | string {
  const position = lngLat(h.position);
  if (!position) return `${h.uid}: position`;
  if (!isReviewStatus(h.review_status)) return `${h.uid}: review_status "${String(h.review_status)}"`;
  return {
    uid: h.uid,
    id: h.borehole_id,
    documentId: h.document_id,
    project: h.project_name ?? null,
    depth: isNumber(h.borehole_depth_m) ? h.borehole_depth_m : null,
    reviewStatus: h.review_status,
    crsStatus: h.crs_status,
    lng: position[0],
    lat: position[1],
    offsetM: h.offset_m,
    chainageM: h.chainage_m,
    side: h.side,
  };
}

/** The boreholes along a line, in the server's chainage order; a hit without a usable position is left out (and reported). */
export function adaptAlignmentResult(w: WireAlignmentResult): AlignmentResult {
  const hits: AlignmentHit[] = [];
  const left: string[] = [];
  for (const h of w.hits) {
    const hit = adaptHit(h);
    if (typeof hit === 'string') left.push(hit);
    else hits.push(hit);
  }
  if (left.length) reportLeftOut('alignment hits', left);
  return {
    alignmentId: w.alignment_id,
    bufferM: w.buffer_m,
    includeUnreviewed: w.include_unreviewed,
    lengthM: w.length_m,
    metricCrs: w.metric_crs,
    band: polygonsOf(w.buffer_polygon),
    hits,
    excludedUnreviewed: w.excluded_unreviewed,
    notOnMap: w.not_on_map,
    resultSet: adaptResultSet(w.result_set),
  };
}

/** A query as the contract's AlignmentQuery. */
export function toWireAlignmentQuery(q: { bufferM: number | null; includeUnreviewed: boolean }): WireAlignmentQuery {
  return { ...(q.bufferM != null ? { buffer_m: q.bufferM } : {}), include_unreviewed: q.includeUnreviewed };
}

/* ---------- places (GET /geocode) ---------- */

/** Place candidates in the server's order (uploaded places first). One without a known source or a position is left out. */
export function adaptPlaces(list: WirePlace[]): PlaceCandidate[] {
  const out: PlaceCandidate[] = [];
  const left: string[] = [];
  for (const p of list ?? []) {
    const label = typeof p?.label === 'string' ? p.label : '?';
    if (p?.source !== 'uploaded' && p?.source !== 'geocoder') left.push(`${label}: source "${String(p?.source)}"`);
    else if (!isNumber(p.lat) || !isNumber(p.lon)) left.push(`${label}: no position`);
    else {
      out.push({
        label, lat: p.lat, lng: p.lon, bbox: toBbox(p.bbox), source: p.source, kind: p.kind ?? null,
        boreholeCount: isNumber(p.borehole_count) ? p.borehole_count : null,
      });
    }
  }
  reportLeftOut(left.length === 1 ? 'place' : 'places', left);
  return out;
}

/* ---------- clarifications ---------- */

const KINDS: readonly ClarificationKind[] = [
  'crs_confirm', 'locate_borehole', 'choose_reading', 'datum_convention', 'unit_ambiguous',
  'borehole_boundary', 'duplicate', 'conflicting_sources', 'chat_parameter',
];
const CLARIFICATION_STATUSES: readonly ClarificationStatus[] = ['open', 'answered', 'skipped'];
const WIDGETS: readonly FormWidget[] = ['text', 'number_unit', 'select', 'boolean', 'map_point', 'choose_reading', 'page_range', 'crs_picker'];

/** A page region as sent, or null without a document and page. The box array becomes a Box. */
function adaptEvidence(e: unknown): Evidence | null {
  if (!isFields(e) || !isText(e.document_id) || !isRevision(e.page)) return null;
  return {
    documentId: e.document_id,
    page: e.page,
    box: toBox(e.box as WireEvidence['box']),
    snippet: typeof e.snippet === 'string' ? e.snippet : null,
  };
}

/** One form field, or why the question can't be shown. The default is kept exactly as sent; absent, it is undefined. */
function adaptField(f: unknown): FormField | string {
  if (!isFields(f) || !isText(f.name) || typeof f.label !== 'string') return 'a field without name or label';
  if (!(WIDGETS as readonly unknown[]).includes(f.widget)) return `widget "${String(f.widget)}"`;
  const options = Array.isArray(f.options) ? f.options : [];
  return {
    name: f.name,
    widget: f.widget as FormWidget,
    label: f.label,
    help: typeof f.help === 'string' ? f.help : null,
    // The contract's default for an absent `required`.
    required: f.required === true,
    unitOptions: Array.isArray(f.unit_options) ? f.unit_options.filter((u): u is string => typeof u === 'string') : [],
    options: options.filter(isFields).map((o) => ({
      value: o.value,
      label: typeof o.label === 'string' ? o.label : String(o.value),
      evidence: o.evidence == null ? null : adaptEvidence(o.evidence),
    })),
    default: 'default' in f ? f.default : undefined,
  };
}

/** A question as a Clarification, or why it can't be shown. */
function clarificationOrReason(c: unknown): Clarification | string {
  if (!isFields(c)) return 'a question that is no object';
  const id = isText(c.clarification_id) ? c.clarification_id : null;
  const name = id ?? '?';
  if (!id || !isText(c.document_id) || typeof c.question !== 'string' || !Array.isArray(c.fields) || typeof c.created_at !== 'string') {
    return `${name}: required fields missing`;
  }
  if (!(KINDS as readonly unknown[]).includes(c.kind)) return `${name}: kind "${String(c.kind)}"`;
  if (!(CLARIFICATION_STATUSES as readonly unknown[]).includes(c.status)) return `${name}: status "${String(c.status)}"`;
  const fields: FormField[] = [];
  for (const raw of c.fields) {
    const f = adaptField(raw);
    if (typeof f === 'string') return `${name}: ${f}`;
    fields.push(f);
  }
  const evidence = Array.isArray(c.evidence) ? c.evidence.map(adaptEvidence).filter((e): e is Evidence => e != null) : [];
  return {
    id,
    kind: c.kind as ClarificationKind,
    status: c.status as ClarificationStatus,
    documentId: c.document_id,
    boreholeUids: Array.isArray(c.borehole_uids) ? c.borehole_uids.filter(isText) : [],
    path: isText(c.path) ? c.path : null,
    question: c.question,
    fields,
    evidence,
    answer: c.answer ?? null,
    answeredBy: typeof c.answered_by === 'string' ? c.answered_by : null,
    createdAt: c.created_at,
    resolvedAt: typeof c.resolved_at === 'string' ? c.resolved_at : null,
  };
}

/**
 * One clarification (a list item, an answer, the data of clarification.created). Null when it lacks
 * what the contract requires or has a kind, status or widget this client doesn't know: the dialog
 * could not render it. Logs nothing (the callers report).
 */
export function adaptClarification(c: unknown): Clarification | null {
  const r = clarificationOrReason(c);
  return typeof r === 'string' ? null : r;
}

/** A list of questions in the server's order; one this client can't show is left out (one console.info per call). */
export function adaptClarifications(list: WireClarification[]): Clarification[] {
  const out: Clarification[] = [];
  const left: string[] = [];
  for (const c of list ?? []) {
    const r = clarificationOrReason(c);
    if (typeof r === 'string') left.push(r);
    else out.push(r);
  }
  reportLeftOut(left.length === 1 ? 'question' : 'questions', left);
  return out;
}

/* ---------- health ---------- */

/** Maps the backend's Health answer. */
/** The health's sign-in settings; anything not stated means no sign-in and no registration. */
function authOf(a: { enabled?: unknown; registration?: unknown } | undefined): Health['auth'] {
  return { enabled: a?.enabled === true, registration: a?.registration === 'open' ? 'open' : 'closed' };
}

export function adaptHealth(h: WireHealth): Health {
  return {
    mode: h.mode,
    status: h.status,
    version: h.version,
    providers: { ...h.providers },
    upload: { maxMb: h.upload.max_mb, extensions: [...h.upload.extensions] },
    // Contract 1.3.0 adds `auth`; a server that doesn't send it has no sign-in.
    auth: authOf((h as { auth?: { enabled?: unknown; registration?: unknown } }).auth),
  };
}

/* ---------- sign-in (contract 1.3.0) ---------- */

/*
 * Local wire types until contracts/openapi.yaml carries the 1.3.0 sign-in endpoints; then they move
 * to the generated Schemas like the rest.
 */
/** User as the server sends it (GET /auth/me, POST /auth/login, POST /auth/register). */
export interface WireUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: 'reviewer' | 'admin';
  created_at: string;
}
/** The answer of /auth/me, /auth/login and /auth/register. */
export interface WireUserAnswer { user: WireUser }
export interface WireLogin { email: string; password: string }
export interface WireRegister { email: string; password: string; display_name?: string }

/**
 * Maps the server's user. A user this client can't show (no id or email, a role it doesn't know)
 * is an error, never a guessed one.
 */
export function adaptUser(w: WireUser): User {
  const u = w as Partial<Record<keyof WireUser, unknown>> | null;
  if (!u || typeof u.user_id !== 'string' || typeof u.email !== 'string') {
    throw new Error("The server answered with a user this client can't show.");
  }
  if (u.role !== 'reviewer' && u.role !== 'admin') {
    throw new Error(`The server answered with a user role this client doesn't know (${String(u.role)}).`);
  }
  return {
    userId: u.user_id,
    email: u.email,
    displayName: typeof u.display_name === 'string' && u.display_name.trim() ? u.display_name : null,
    role: u.role,
    createdAt: typeof u.created_at === 'string' ? u.created_at : '',
  };
}
