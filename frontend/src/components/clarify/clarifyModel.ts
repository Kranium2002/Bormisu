/**
 * Pure model of the clarification UI (FRONTEND.md F12): the inbox's lists and groups, the inputs of
 * the question form and the answer they make. No React, no store: unit-tested in clarifyModel.test.ts.
 *
 * Rules: inputs start from the field's `default` only (the server's suggestion), never from a value
 * the client makes up; a required field left empty is an error next to it, and nothing is sent for
 * it; the answer uses the contract's shapes (backend app/clarify/answers.py): number_unit
 * `{value, unit}`, map_point `{lat, lon}`, page_range `[from, to]`, an option's own `value` for
 * select / choose_reading / crs_picker, `true` / `false` for boolean, the trimmed text for text.
 */
import type { Box, Clarification, ClarificationKind, CrsCandidate, DocumentSummary, Evidence, FormField } from '../../domain/types';

/** Short label of each question kind (inbox chips, the dialog's title). */
export const KIND_LABEL: Record<ClarificationKind, string> = {
  crs_confirm: 'Coordinate system',
  locate_borehole: 'Borehole position',
  choose_reading: 'Which reading',
  datum_convention: 'Datum',
  unit_ambiguous: 'Unit',
  borehole_boundary: 'Borehole pages',
  duplicate: 'Duplicate',
  conflicting_sources: 'Conflicting sources',
  chat_parameter: 'Chat question',
};

/** The label of a kind; a kind this client does not know yet (the contract may add one) shows as sent. */
export function kindLabel(kind: ClarificationKind): string {
  return KIND_LABEL[kind] ?? String(kind).replace(/_/g, ' ');
}

/* ---------- lists ---------- */

/** Open or skipped: a skipped question is left for later but still unresolved (contract). */
export const isUnresolved = (c: Pick<Clarification, 'status'>) => c.status !== 'answered';

export function unresolved<T extends Pick<Clarification, 'status'>>(list: readonly T[]): T[] {
  return list.filter(isUnresolved);
}

export function unresolvedCount(list: readonly Pick<Clarification, 'status'>[]): number {
  return list.reduce((n, c) => n + (isUnresolved(c) ? 1 : 0), 0);
}

/** "3 unresolved questions". */
export function questionCountText(n: number): string {
  return `${n} unresolved question${n === 1 ? '' : 's'}`;
}

export interface QuestionGroup {
  documentId: string;
  /** File name of the document; null when the app has not loaded it (never a made-up name). */
  name: string | null;
  questions: Clarification[];
}

/**
 * Unresolved questions grouped by document, in the order of each document's oldest question (the
 * list comes oldest first), each group in list order.
 */
export function groupByDocument(list: readonly Clarification[], documents: readonly Pick<DocumentSummary, 'id' | 'name'>[]): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>();
  for (const c of unresolved(list)) {
    let g = groups.get(c.documentId);
    if (!g) {
      g = { documentId: c.documentId, name: documents.find((d) => d.id === c.documentId)?.name ?? null, questions: [] };
      groups.set(c.documentId, g);
    }
    g.questions.push(c);
  }
  return [...groups.values()];
}

/** The question a document's badge opens: its oldest open question, else its oldest skipped one; null when none. */
export function firstQuestionOf(list: readonly Clarification[], documentId: string): string | null {
  const mine = list.filter((c) => c.documentId === documentId);
  return (mine.find((c) => c.status === 'open') ?? mine.find((c) => c.status === 'skipped'))?.id ?? null;
}

/** Unresolved questions about one borehole, oldest first. */
export function questionsOfBorehole(list: readonly Clarification[], uid: string): Clarification[] {
  return list.filter((c) => isUnresolved(c) && c.boreholeUids.includes(uid));
}

/**
 * The unresolved CRS question that covers a document: asked about the document itself or about one
 * of its boreholes (a question can cover every document of a project). Null when there is none.
 */
export function crsQuestionFor(list: readonly Clarification[], documentId: string, uids: readonly string[]): Clarification | null {
  return (
    list.find(
      (c) => c.kind === 'crs_confirm' && isUnresolved(c) && (c.documentId === documentId || c.boreholeUids.some((u) => uids.includes(u))),
    ) ?? null
  );
}

/** The affected boreholes by their printed IDs ("BH-1, BH-2"); a borehole the app has not loaded shows its uid. */
export function boreholeText(uids: readonly string[], known: readonly { uid: string; id: string }[]): string {
  return uids.map((u) => known.find((b) => b.uid === u)?.id ?? u).join(', ');
}

/**
 * The value a question's path is about: the value whose key is the path (values without a dedicated
 * row are keyed by their path) or that names the path among its source `paths` (when the data layer
 * provides them). Null without a path or a match.
 */
export function valueKeyForPath(values: readonly { key: string; paths?: readonly string[] }[], path: string | null): string | null {
  if (!path) return null;
  return (values.find((v) => v.key === path) ?? values.find((v) => v.paths?.includes(path)))?.key ?? null;
}

/** Created time for the inbox, in the reader's own locale; '' when the server's time can't be read. */
export function createdText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One page the backend cites, with every box and snippet it cites on it. */
export interface EvidencePage { documentId: string; page: number; boxes: Box[]; snippets: (string | null)[] }

/** Evidence by page, in the order the backend lists it; boxes and snippets of one page together. */
export function evidencePages(evidence: readonly Evidence[]): EvidencePage[] {
  const pages = new Map<string, EvidencePage>();
  for (const e of evidence) {
    const key = `${e.documentId}:${e.page}`;
    let p = pages.get(key);
    if (!p) {
      p = { documentId: e.documentId, page: e.page, boxes: [], snippets: [] };
      pages.set(key, p);
    }
    if (e.box) {
      p.boxes.push(e.box);
      p.snippets.push(e.snippet);
    } else if (e.snippet) {
      p.snippets.push(e.snippet);
    }
  }
  return [...pages.values()];
}

/* ---------- the form ---------- */

/** What the reviewer has entered in one field (text as typed; options by index, since their values are any JSON). */
export type FieldInput =
  | { kind: 'text'; text: string }
  | { kind: 'number_unit'; number: string; unit: string }
  | { kind: 'choice'; index: number | null; none: boolean }
  | { kind: 'boolean'; value: boolean | null }
  | { kind: 'point'; lat: string; lon: string }
  | { kind: 'range'; from: string; to: string };

export type FormInputs = Record<string, FieldInput>;

/** Deep equality of two JSON values (option values and defaults). */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const numText = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? String(x) : '');
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The input of one field before the reviewer touches it: the server's default, else empty (undefined and null are no default). */
export function initialInput(f: FormField): FieldInput {
  const d = f.default;
  switch (f.widget) {
    case 'text':
      return { kind: 'text', text: typeof d === 'string' ? d : typeof d === 'number' ? String(d) : '' };
    case 'number_unit': {
      if (isRecord(d)) {
        const unit = typeof d.unit === 'string' && f.unitOptions.includes(d.unit) ? d.unit : '';
        return { kind: 'number_unit', number: numText(d.value), unit };
      }
      return { kind: 'number_unit', number: numText(d), unit: '' };
    }
    case 'select':
    case 'choose_reading':
    case 'crs_picker': {
      // The wire sends `default: null` for "no default": null never selects an option.
      const i = d == null ? -1 : f.options.findIndex((o) => sameJson(o.value, d));
      return { kind: 'choice', index: i >= 0 ? i : null, none: false };
    }
    case 'boolean':
      return { kind: 'boolean', value: typeof d === 'boolean' ? d : null };
    case 'map_point':
      return isRecord(d) ? { kind: 'point', lat: numText(d.lat), lon: numText(d.lon) } : { kind: 'point', lat: '', lon: '' };
    case 'page_range': {
      if (Array.isArray(d)) return { kind: 'range', from: numText(d[0]), to: numText(d[d.length - 1]) };
      if (isRecord(d)) return { kind: 'range', from: numText(d.from), to: numText(d.to) };
      return { kind: 'range', from: '', to: '' };
    }
  }
}

export function initialInputs(fields: readonly FormField[]): FormInputs {
  return Object.fromEntries(fields.map((f) => [f.name, initialInput(f)]));
}

/** A number as typed, with a decimal point or comma; null when the text is no plain number. */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (!/^[-+]?(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const REQUIRED: Record<FormField['widget'], string> = {
  text: 'This field is required.',
  number_unit: 'Enter a number.',
  select: 'Choose one of the options.',
  boolean: 'Choose yes or no.',
  map_point: 'Click the map or enter the latitude and longitude.',
  choose_reading: 'Choose one of the readings.',
  page_range: 'Enter the first and the last page.',
  crs_picker: 'Choose a coordinate system.',
};

type Outcome = { value: unknown } | { error: string } | { empty: true };

/** One field's answer, its error, or nothing (left empty). */
function fieldAnswer(f: FormField, input: FieldInput | undefined, pageCount: number | null): Outcome {
  const empty = { empty: true } as const;
  if (!input) return empty;
  switch (input.kind) {
    case 'text': {
      const t = input.text.trim();
      return t ? { value: t } : empty;
    }
    case 'number_unit': {
      if (!input.number.trim()) return empty;
      const n = parseNumber(input.number);
      if (n === null) return { error: 'Enter a number, for example 1.95.' };
      if (!f.unitOptions.length) return { value: { value: n, unit: null } };
      if (!f.unitOptions.includes(input.unit)) return { error: 'Choose a unit.' };
      return { value: { value: n, unit: input.unit } };
    }
    case 'choice': {
      if (input.none && !f.required) return { value: null };
      const o = input.index === null ? undefined : f.options[input.index];
      return o ? { value: o.value } : empty;
    }
    case 'boolean':
      return input.value === null ? empty : { value: input.value };
    case 'point': {
      if (!input.lat.trim() && !input.lon.trim()) return empty;
      const lat = parseNumber(input.lat);
      const lon = parseNumber(input.lon);
      if (lat === null || lon === null) return { error: REQUIRED.map_point };
      if (lat < -90 || lat > 90) return { error: 'The latitude must be between -90 and 90.' };
      if (lon < -180 || lon > 180) return { error: 'The longitude must be between -180 and 180.' };
      return { value: { lat, lon } };
    }
    case 'range': {
      if (!input.from.trim() && !input.to.trim()) return empty;
      if (!input.from.trim() || !input.to.trim()) return { error: REQUIRED.page_range };
      const from = parseNumber(input.from);
      const to = parseNumber(input.to);
      const ok = (n: number | null): n is number => n !== null && Number.isInteger(n) && n >= 1 && (pageCount === null || n <= pageCount);
      if (!ok(from) || !ok(to)) return { error: pageCount ? `Pages are whole numbers from 1 to ${pageCount}.` : 'Pages are whole numbers from 1.' };
      if (from > to) return { error: 'The first page must not come after the last.' };
      return { value: [from, to] };
    }
  }
}

/**
 * The answer the inputs make: `values` by field name (an empty optional field is left out) and an
 * error per field that can't be sent as it is. Send only when `errors` is empty.
 */
export function answerValues(
  fields: readonly FormField[],
  inputs: FormInputs,
  ctx: { pageCount: number | null },
): { values: Record<string, unknown>; errors: Record<string, string> } {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const r = fieldAnswer(f, inputs[f.name], ctx.pageCount);
    if ('error' in r) errors[f.name] = r.error;
    else if ('value' in r) values[f.name] = r.value;
    else if (f.required) errors[f.name] = REQUIRED[f.widget];
  }
  return { values, errors };
}

/* ---------- CRS ---------- */

/**
 * The swap flag the form holds: the boolean field the contract names `swap_axes` (the CRS question's
 * second field), or null when the form has none or it is unanswered.
 */
export function swapAxesInput(fields: readonly FormField[], inputs: FormInputs): boolean | null {
  const f = fields.find((x) => x.name === 'swap_axes' && x.widget === 'boolean');
  const input = f ? inputs[f.name] : undefined;
  return input?.kind === 'boolean' ? input.value : null;
}

/**
 * The document's candidate behind each option of a crs_picker field, matched by code: the candidate
 * with the form's axis order when there are both, else the first listed (the server ranks them).
 * An option the server listed no candidate for gets null (shown without a preview).
 */
export function crsOptionCandidates(field: FormField, candidates: readonly CrsCandidate[], swapAxes: boolean | null): (CrsCandidate | null)[] {
  return field.options.map((o) => {
    const same = candidates.filter((c) => c.code === o.value);
    return (swapAxes === null ? undefined : same.find((c) => c.swapAxes === swapAxes)) ?? same[0] ?? null;
  });
}
