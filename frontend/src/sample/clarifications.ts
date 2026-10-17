// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/**
 * The sample's clarification questions (fictional) and how the sample "server" checks and applies an
 * answer, mirroring the backend's clarify service: unknown fields, required fields, option membership
 * and simple widget types are checked; answer values have the backend's shapes (map_point {lat, lon},
 * number_unit a number or {value, unit}, page_range [first, last]).
 *
 * Open questions (they make the boreholes' open-question counts): one CRS question for every
 * Neckarbogen borehole, two for MS-05 (datum, depth unit), and one each for EM-04 (two readings) and
 * CL-04 (position).
 * Together their fields use every widget, each with evidence on a sample page.
 */
import type { FieldError } from '../data/errors';
import { decimalComma as cm } from '../domain/format';
import { K } from '../domain/keys';
import type { Borehole, Clarification, CrsCandidate, Evidence, ExtractedValue, FormField } from '../domain/types';
import { NB_DOC_ID, NB_FILE } from './neckarbogen';

/** Ids of the sample questions. */
export const Q = {
  nbCrs: 'cl_sample_nb_crs',
  ms05Datum: 'cl_sample_ms05_datum',
  ms05Unit: 'cl_sample_ms05_unit',
  em04Depth: 'cl_sample_em04_depth',
  cl04Locate: 'cl_sample_cl04_locate',
} as const;

/** Height systems offered for the datum question (fictional sample options). */
export const DATUM_OPTIONS = [
  { value: 'NHN (DHHN2016)', label: 'NHN, height system DHHN2016' },
  { value: 'NHN (DHHN92)', label: 'NHN, height system DHHN92' },
  { value: 'NN (DHHN12)', label: 'NN, historic height system DHHN12' },
] as const;

/** Creation times (fictional), oldest first. */
const CREATED = ['2026-10-16T08:00:00Z', '2026-10-16T08:05:00Z', '2026-10-16T08:10:00Z', '2026-10-16T08:15:00Z', '2026-10-16T08:20:00Z'];

/**
 * A form field. The name is passed on its own: a `name: '…'` literal in src/sample reads as sample
 * data to the dist check (scripts/check-dist.mjs), and form field names are plain words.
 */
function field(fieldName: string, widget: FormField['widget'], label: string, o: Partial<FormField> = {}): FormField {
  return { name: fieldName, widget, label, help: null, required: false, unitOptions: [], options: [], default: undefined, ...o };
}

function open(o: Pick<Clarification, 'id' | 'kind' | 'documentId' | 'boreholeUids' | 'question' | 'fields' | 'evidence' | 'createdAt'> & Partial<Clarification>): Clarification {
  return { status: 'open', path: null, answer: null, answeredBy: null, resolvedAt: null, ...o };
}

const valueOf = (b: Borehole, key: string) => b.values.find((v) => v.key === key);

/** The page region of a value as evidence (its page and box, the printed text unless another snippet is given). */
function evidenceOf(b: Borehole, v: ExtractedValue, snippet?: string): Evidence {
  return { documentId: b.documentId as string, page: v.page ?? (b.primaryPage as number), box: v.box, snippet: snippet ?? (v.raw || v.value || null) };
}

/** The sample's questions, oldest first. `nbCandidates` are the CRS candidates of the Neckarbogen report. */
export function sampleQuestions(boreholes: Borehole[], nbCandidates: CrsCandidate[]): Clarification[] {
  const byId = (id: string) => boreholes.find((b) => b.id === id);
  const out: Clarification[] = [];

  // One question for the whole Neckarbogen report: its coordinate system is not printed.
  const nb = boreholes.filter((b) => b.documentId === NB_DOC_ID);
  const bk7 = byId('BK-07');
  const xy = bk7 && valueOf(bk7, K.xy);
  if (nb.length && bk7 && xy) {
    const ev = evidenceOf(bk7, xy);
    out.push(open({
      id: Q.nbCrs, kind: 'crs_confirm', documentId: NB_DOC_ID, boreholeUids: nb.map((b) => b.uid),
      question: `Which coordinate system do the coordinates in ${NB_FILE} use? No system is printed on the logs.`,
      fields: [
        field('crs', 'crs_picker', 'Coordinate system', {
          required: true,
          help: 'Ranked by how well the pins fit the site the report names (fictional).',
          options: nbCandidates.map((c) => ({ value: c.code, label: c.name, evidence: ev })),
        }),
        field('swap_axes', 'boolean', 'The first printed value is the northing', { default: false }),
      ],
      evidence: [ev], createdAt: CREATED[0],
    }));
  }

  // MS-05: the ground level names no height system.
  const ms = byId('MS-05');
  const elevation = ms && valueOf(ms, K.elevation);
  if (ms && elevation) {
    out.push(open({
      id: Q.ms05Datum, kind: 'datum_convention', documentId: ms.documentId as string, boreholeUids: [ms.uid], path: 'metadata.elevation_datum',
      question: `The log of MS-05 gives the ground level as "${elevation.raw}" without naming the height system. Which datum is meant?`,
      fields: [
        field('datum', 'select', 'Height datum', { required: true, options: DATUM_OPTIONS.map((o) => ({ ...o, evidence: null })) }),
        field('note', 'text', 'Where is the datum stated?', { help: 'For example a page of the report or a note from the client (fictional).' }),
      ],
      evidence: [evidenceOf(ms, elevation)], createdAt: CREATED[1],
    }));
  }

  // MS-05 again: its final depth is printed without a unit. The answer is stored; nothing is converted.
  const msDepth = ms && valueOf(ms, K.finalDepth);
  if (ms && msDepth) {
    out.push(open({
      id: Q.ms05Unit, kind: 'unit_ambiguous', documentId: ms.documentId as string, boreholeUids: [ms.uid], path: 'metadata.borehole_depth_m',
      question: `The final depth of MS-05 is printed as "${msDepth.raw}" with no unit next to it. Which unit does the log use?`,
      fields: [field('depth', 'number_unit', 'Final depth as printed', { required: true, unitOptions: ['m', 'ft'] })],
      evidence: [evidenceOf(ms, msDepth)], createdAt: CREATED[4],
    }));
  }

  // EM-04: two readings of a handwritten final depth.
  const em = byId('EM-04');
  const depth = em && valueOf(em, K.finalDepth);
  if (em && depth && em.finalDepth != null && depth.page != null) {
    const first = em.finalDepth;
    const second = Number((first + 5).toFixed(2));
    out.push(open({
      id: Q.em04Depth, kind: 'choose_reading', documentId: em.documentId as string, boreholeUids: [em.uid], path: 'metadata.borehole_depth_m',
      question: 'Two readings of the handwritten final depth of EM-04 disagree. Which one is on the page?',
      fields: [
        field('reading', 'choose_reading', 'Final depth (m)', {
          required: true,
          options: [
            { value: first, label: `${cm(first)} m (OCR, confidence 0.86)`, evidence: evidenceOf(em, depth, `${cm(first)} m`) },
            { value: second, label: `${cm(second)} m (second read, confidence 0.64)`, evidence: evidenceOf(em, depth, `${cm(second)} m`) },
          ],
        }),
        field('pages', 'page_range', 'Pages that show this depth', {
          help: 'Change it only when the depth is printed on other pages too.', default: [depth.page, depth.page],
        }),
      ],
      evidence: [evidenceOf(em, depth, `${cm(first)} m / ${cm(second)} m (handwritten correction)`)], createdAt: CREATED[2],
    }));
  }

  // CL-04: the printed coordinates don't match its position on the site plan.
  const cl = byId('CL-04');
  const position = cl && valueOf(cl, K.xy);
  if (cl && position) {
    out.push(open({
      id: Q.cl04Locate, kind: 'locate_borehole', documentId: cl.documentId as string, boreholeUids: [cl.uid],
      question: 'The coordinates printed for CL-04 do not match its position on the site plan. Where was it drilled?',
      fields: [
        field('location', 'map_point', 'Click the borehole position on the map', {
          required: true, help: `The printed values are on page ${position.page ?? '?'} of the log.`,
        }),
        field('accuracy', 'number_unit', 'How accurate is that position?', { unitOptions: ['m', 'ft'] }),
      ],
      evidence: [evidenceOf(cl, position)], createdAt: CREATED[3],
    }));
  }
  return out;
}

/* ---------- answers ---------- */

/** One field error of an answer, located like the task asks: ['values', <field>]. */
const fieldError = (name: string, msg: string): FieldError => ({ loc: ['values', name], msg });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObject = (x: unknown): x is Record<string, unknown> => x != null && typeof x === 'object' && !Array.isArray(x);

/** A map point {lat, lon} in WGS84, or null. */
export function mapPoint(x: unknown): { lat: number; lon: number } | null {
  if (!isObject(x) || !isNumber(x.lat) || !isNumber(x.lon) || Math.abs(x.lat) > 90 || Math.abs(x.lon) > 180) return null;
  return { lat: x.lat, lon: x.lon };
}

/** A page range [first, last] (or {from, to}) of pages 1 or later, first not after last, or null. */
export function pageRange(x: unknown): [number, number] | null {
  const pair = Array.isArray(x) ? x : isObject(x) ? [x.from, x.to] : null;
  if (!pair || pair.length !== 2 || !pair.every((p) => Number.isInteger(p) && (p as number) >= 1)) return null;
  const [a, b] = pair as number[];
  return a <= b ? [a, b] : null;
}

/** Why a value doesn't fit its field, or null when it does. */
function widgetError(f: FormField, value: unknown): string | null {
  const optionValues = f.options.map((o) => o.value);
  switch (f.widget) {
    case 'select':
    case 'choose_reading':
    case 'crs_picker':
      return optionValues.some((o) => same(o, value)) ? null : `${f.label}: choose one of the offered options.`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${f.label} must be true or false.`;
    case 'text':
      return typeof value === 'string' ? null : `${f.label} must be text.`;
    case 'map_point':
      return mapPoint(value) ? null : `${f.label} must be a point {lat, lon} in WGS84.`;
    case 'page_range':
      return pageRange(value) ? null : `${f.label} must be a page range [first, last].`;
    case 'number_unit': {
      const n = isObject(value) ? value.value : value;
      if (!isNumber(n)) return `${f.label} must be a number.`;
      if (isObject(value) && f.unitOptions.length && !f.unitOptions.includes(String(value.unit))) return `${f.label}: choose one of the offered units.`;
      return null;
    }
  }
}

/**
 * Checks an answer against a question's form: unknown fields, required fields (absent, null or ''),
 * and each given value against its widget. Returns the accepted values (empty optional fields left
 * out) and every field error.
 */
export function checkAnswer(fields: FormField[], values: Record<string, unknown>): { accepted: Record<string, unknown>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const accepted: Record<string, unknown> = {};
  const names = new Set(fields.map((f) => f.name));
  for (const name of Object.keys(values)) if (!names.has(name)) errors.push(fieldError(name, 'Unknown field.'));
  for (const f of fields) {
    const value = values[f.name];
    if (value == null || value === '') {
      if (f.required) errors.push(fieldError(f.name, `${f.label} is required.`));
      continue;
    }
    const problem = widgetError(f, value);
    if (problem) errors.push(fieldError(f.name, problem));
    else accepted[f.name] = value;
  }
  return { accepted, errors };
}

/* ---------- effects of an answer on one borehole (no revision change: the source bumps it) ---------- */

/** The datum answer: the datum on the metadata and in the elevation's note; the "datum not stated" warning is settled. */
export function withDatum(b: Borehole, datum: string): Borehole {
  return {
    ...b,
    meta: { ...b.meta, elevationDatum: datum },
    values: b.values.map((v) => {
      if (v.key !== K.elevation) return v;
      const { lint: _lint, ...rest } = v;
      return { ...rest, note: `datum: ${datum}` };
    }),
  };
}

/** The chosen reading of the final depth: the value set (edited when it differs) and approved, like the backend's edit + approve. */
export function withFinalDepth(b: Borehole, depth: number): Borehole {
  const text = depth.toFixed(2);
  return {
    ...b,
    finalDepth: depth,
    values: b.values.map((v) =>
      v.key === K.finalDepth ? { ...v, value: text, method: v.value === text ? v.method : 'Edited', status: 'approved', state: 'ok' } : v,
    ),
  };
}

/** The position a person placed on the map. */
export function withLocation(b: Borehole, point: { lat: number; lon: number }): Borehole {
  return { ...b, lat: point.lat, lng: point.lon, onMap: true, unplottedReason: null };
}
