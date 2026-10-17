/**
 * Maps the backend's wire shapes (contracts/openapi.yaml, generated into ./api-types.gen) to the
 * domain. This module and apiSource.ts are the only ones that know wire field names.
 * Unknown stays unknown (null or ''): never a default value the source doesn't state.
 */
import { K } from '../domain/keys';
import { placeholderPage } from '../domain/pages';
import { formatSpt, sptLint } from '../domain/spt';
import type {
  Borehole,
  BoreholeMeta,
  Box,
  CrsCandidate,
  DocumentPage,
  DocumentStatus,
  DocumentStep,
  DocumentSummary,
  ExtractedValue,
  FieldState,
  GroundwaterReading,
  GroundwaterType,
  Health,
  Layer,
  Lint,
  LintFinding,
  Method,
  Reading,
  ReviewStatus,
  Sample,
  Spt,
  TestResult,
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

/* ---------- small mappers ---------- */

const METHODS: Record<Schemas['Method'], Method> = { read: 'Read', ocr: 'OCR', derived: 'Derived', guessed: 'Guessed', edited: 'Edited' };
const STATES: Record<WireProvenance['state'], FieldState> = { ok: 'ok', not_in_source: 'not in source', illegible: 'illegible' };

function toBox(b: WireProvenance['box']): Box | null {
  return b && b.length === 4 ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null;
}

function toStatus(s: WireProvenance['status'] | undefined): ReviewStatus {
  return s === 'approved' || s === 'flagged' ? s : 'unreviewed';
}

/** Domain field state → backend `state` (for PATCH bodies). */
export function toApiState(s: FieldState): NonNullable<WireValuePatch['state']> {
  return s === 'not in source' ? 'not_in_source' : s === 'illegible' ? 'illegible' : 'ok';
}

const depthText = (v: number) => v.toFixed(2);

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
 * two fields (X / Y) keeps the whole `pair` (X first); an edit is split on " / " and each part goes to
 * its path, as long as that path is a provenance key.
 */
export interface PatchTarget {
  paths: string[];
  type: PatchValueType;
  pair?: readonly [string, string];
}

/** A domain borehole plus the backend target of each patchable value key. */
export interface AdaptedBorehole {
  borehole: Borehole;
  /** Only values whose paths are provenance keys are patchable. */
  targets: Record<string, PatchTarget>;
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
  extra?: Partial<ExtractedValue>;
}

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
  uscs_group: 'USCS group', spt_raw: 'SPT as printed', spt_refusal: 'SPT refusal', spt_increments: 'SPT increments',
  spt_increment_mm: 'SPT increment length', spt_penetration_cm: 'SPT penetration', spt_depth_m: 'SPT depth',
  elevation_m: 'GW elevation', date: 'Date', raw: 'As printed', type: 'Type', type_code: 'Sample type',
  depth_to_m: 'Depth to', latitude: 'Latitude', longitude: 'Longitude', crs_code: 'CRS code', x_raw: 'X as printed',
  y_raw: 'Y as printed', axis_labels_raw: 'Axis labels as printed', aliases: 'Aliases', borehole_depth_source: 'Depth source',
  qualifier: 'Qualifier', unit: 'Unit', sample_name: 'Sample', depth_m: 'Depth',
};

const NUMERIC_FIELD = /(_m|_pct|_mpa|_deg|_cm|_mm|_mASL|_value)$/;

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
 * for every non-null field the UI shows. A non-null value without provenance is a backend bug: it gets
 * a row without method or confidence, can't be patched, and logs one console warning.
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
      console.warn(`Backend bug: borehole ${uid} has a value at ${paths.join(' / ')} without a provenance entry.`);
      v = {
        key: s.key, field: s.field, label: s.label, ...placed, raw: s.rawFallback ?? '', value: text, unit: s.unit ?? '',
        page: null, box: null, hasProvenance: false, method: null, confidence: null, status: 'unreviewed', state: 'ok',
        aiValue: text, ...s.extra,
      };
    } else {
      const cell = ps.find((p) => p.cell)?.cell ?? null;
      const page = cell ? null : (ps.find((p) => p.page != null)?.page ?? null);
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
      targets[s.key] = { paths: provPaths, type: s.type ?? 'string', ...(pair ? { pair } : {}) };
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
  meta(K.elevation, 'metadata.surface_elevation_mASL', 'Surface Elevation', 'Surface elevation', md.surface_elevation_mASL,
    md.elevation_datum ? `m ${md.elevation_datum}` : 'm', 'number', depthText);
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
    const type: PatchValueType =
      typeof wire === 'number' || (wire == null && NUMERIC_FIELD.test(name)) ? 'number'
        : typeof wire === 'boolean' || name.startsWith('is_') || name === 'spt_refusal' ? 'boolean' : 'string';
    add({
      key: path, path, field: name, label: GENERIC_LABELS[name] ?? name.replace(/_/g, ' '), ...placeOf(path),
      value: wire, type, shown: true,
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
      crs: { name: co.coordinate_system ?? null, code: co.crs_code ?? null, status: rec.crs_status },
      meta: boreholeMeta,
      layers,
      groundwater,
      samples,
      testResults,
      rockHead: rec.rock_head_m ?? null,
      values,
      pages,
      primaryPage: pages[0] ?? 1,
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

function adaptLayer(l: WireLayer, i: number, add: Add, has: (p: string) => boolean): Layer {
  const n = i + 1;
  const base = `stratigraphy[${i}]`;
  const at = { group: 'layer' as const, layer: n };
  const din = l.din4023_code ?? null;
  add({ ...at, key: K.bottom(n), path: `${base}.depth_to_m`, field: EXTRA_FIELDS.depthTo, label: 'Bottom depth',
    value: l.depth_to_m, format: depthText, unit: 'm', type: 'number' });
  const lith = add({
    ...at, key: K.lithology(n), path: `${base}.english_lithology`, field: 'Lithology/SoilName', label: 'Lithology',
    value: l.english_lithology, rawFallback: l.original_description ?? '', extra: { kind: 'lithology', ...(din ? { din } : {}) },
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
    // The increment lint is added once the backend's own findings are attached (adaptBorehole).
    add({
      ...at, key: K.spt(n), path, field: 'SPT', label: spt.depth == null ? 'SPT (depth not stated)' : `SPT @ ${spt.depth.toFixed(2)} m`,
      value: null, text: formatSpt(spt), rawFallback: spt.raw, shown: true,
      type: path.endsWith('spt_n_value') ? 'spt' : path.endsWith('spt_refusal') ? 'boolean' : 'string',
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

/** Every groundwater reading, keyed by its index in the backend list (depth may be null). */
function adaptGroundwater(rec: WireBorehole, add: Add): GroundwaterReading[] {
  const list = rec.groundwater ?? [];
  const origin = rec.metadata.depth_origin;
  const unit = origin == null || origin === 'ground' ? 'm bgl' : 'm';
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
    step: stepOf(d.status),
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

/* ---------- health ---------- */

/** Maps the backend's Health answer. */
export function adaptHealth(h: WireHealth): Health {
  return {
    mode: h.mode,
    status: h.status,
    version: h.version,
    providers: { ...h.providers },
    upload: { maxMb: h.upload.max_mb, extensions: [...h.upload.extensions] },
  };
}
