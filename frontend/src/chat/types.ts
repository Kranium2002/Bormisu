/**
 * Shapes of the chat stream (contracts/realtime-and-chat.md section 2): the custom data parts of
 * section 2.2 as the backend sends them, the AI SDK message type that carries them, and parsers that
 * take a part's `data` (untrusted JSON from the stream) and return it typed, or null when it isn't
 * the shape the contract defines. The chat module is the one place besides src/data that knows these
 * wire names; the UI renders only what the parsers return.
 */
import type { UIMessage } from 'ai';

type Bbox = [number, number, number, number];

/** `data-result-set`: a result set the server created for the answer. */
export interface ResultSetPartData {
  result_set_id: string;
  count: number;
  located_count?: number;
  unlocated_count?: number;
  bbox?: number[] | null;
  area?: unknown;
}

/** `data-citation`: a source of a statement; `[n]` in the text refers to the n-th citation of the message. */
export interface CitationPartData {
  citation_id: string;
  document_id: string;
  page: number | null;
  box?: number[] | null;
  uid?: string;
  path?: string;
  snippet?: string;
}

/** `data-scope`: what the answer covers. */
export interface ScopePartData {
  included: string;
  excluded_unreviewed: number;
  unlocated_in_scope: number;
  documents_processing: number;
}

/** `data-ui-command` (transient): one command of the allowlist in section 2.3. */
export interface UiCommandData {
  command: string;
  args?: Record<string, unknown>;
}

/** The data parts of a chat message, by name (`data-<name>`). `clarification` is the full wire Clarification. */
export type ChatDataTypes = {
  'result-set': ResultSetPartData;
  citation: CitationPartData;
  scope: ScopePartData;
  'ui-command': UiCommandData;
  clarification: unknown;
};

/** A message of the chat (AI SDK UIMessage with this contract's data parts). */
export type ChatMessage = UIMessage<unknown, ChatDataTypes>;
export type ChatPart = ChatMessage['parts'][number];

/* ---------- parsers (untrusted stream data → typed, or null) ---------- */

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const count = (x: unknown): number | null => (isNumber(x) && x >= 0 ? x : null);

/** A bbox [min_lon, min_lat, max_lon, max_lat] of finite numbers within the world's ranges, else null. */
export function validBbox(x: unknown): Bbox | null {
  if (!Array.isArray(x) || x.length !== 4 || !x.every(isNumber)) return null;
  const [minLon, minLat, maxLon, maxLat] = x as number[];
  const lonOk = (v: number) => v >= -180 && v <= 180;
  const latOk = (v: number) => v >= -90 && v <= 90;
  if (!lonOk(minLon) || !lonOk(maxLon) || !latOk(minLat) || !latOk(maxLat) || minLat > maxLat) return null;
  return [minLon, minLat, maxLon, maxLat];
}

/** A page box [x, y, w, h] (normalised to the page) as the domain's Box, else null. */
export function pageBox(x: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!Array.isArray(x) || x.length !== 4 || !x.every(isNumber)) return null;
  const [bx, by, w, h] = x as number[];
  return { x: bx, y: by, w, h };
}

/** The result card's data: the set's id and counts (located / unlocated null when not sent). */
export interface ResultCardData {
  id: string;
  count: number;
  located: number | null;
  unlocated: number | null;
}

export function parseResultSet(data: unknown): ResultCardData | null {
  if (!isRecord(data) || !isText(data.result_set_id)) return null;
  const n = count(data.count);
  if (n === null) return null;
  return { id: data.result_set_id, count: n, located: count(data.located_count), unlocated: count(data.unlocated_count) };
}

/** A citation as the chips use it. `page` is null for a source without a page (a spreadsheet cell). */
export interface Citation {
  id: string;
  documentId: string;
  page: number | null;
  box: { x: number; y: number; w: number; h: number } | null;
  uid: string | null;
  path: string | null;
  snippet: string;
}

export function parseCitation(data: unknown): Citation | null {
  if (!isRecord(data) || !isText(data.document_id)) return null;
  const page = isNumber(data.page) && Number.isInteger(data.page) && data.page >= 1 ? data.page : null;
  return {
    id: isText(data.citation_id) ? data.citation_id : '',
    documentId: data.document_id,
    page,
    box: pageBox(data.box),
    uid: isText(data.uid) ? data.uid : null,
    path: isText(data.path) ? data.path : null,
    snippet: typeof data.snippet === 'string' ? data.snippet : '',
  };
}

export interface Scope {
  included: string;
  excludedUnreviewed: number | null;
  unlocatedInScope: number | null;
  documentsProcessing: number | null;
}

export function parseScope(data: unknown): Scope | null {
  if (!isRecord(data) || typeof data.included !== 'string') return null;
  return {
    included: data.included,
    excludedUnreviewed: count(data.excluded_unreviewed),
    unlocatedInScope: count(data.unlocated_in_scope),
    documentsProcessing: count(data.documents_processing),
  };
}

export function parseUiCommand(data: unknown): { command: string; args: Record<string, unknown> } | null {
  if (!isRecord(data) || !isText(data.command)) return null;
  return { command: data.command, args: isRecord(data.args) ? data.args : {} };
}

/** A tool's error output (`{error: {code, message}}`), else null. */
export function toolError(output: unknown): { code: string; message: string } | null {
  if (!isRecord(output) || !isRecord(output.error)) return null;
  const e = output.error;
  const message = typeof e.message === 'string' ? e.message : '';
  const code = typeof e.code === 'string' ? e.code : '';
  return message || code ? { code, message } : null;
}
