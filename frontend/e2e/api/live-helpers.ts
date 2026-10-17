/**
 * Fictional payloads for e2e/api/live.spec.ts: a document and a borehole that exist only in the
 * test (built from the frontend's fictional contract fixtures in src/test/contract), the states the
 * recorded event stream walks through, and the server-sent-events framing of
 * contracts/realtime-and-chat.md section 1. No challenge data.
 */
import { readFileSync } from 'node:fs';
import type { WireDocument, WireRecord } from './fixtures';

/** Ids of the test's own document and borehole: the seed never has them. */
export const LIVE_DOC = 'doc_01JFICTLIVE000000000000D9';
export const LIVE_UID = 'bh_01JFICTLIVE000000000000B9';
export const LIVE_FILE = 'live_fictional_log.pdf';
export const LIVE_BOREHOLE_ID = 'LV-01';

/** The `example` of one of the frontend's fictional contract fixtures. */
function example<T>(name: string): T {
  const env = JSON.parse(readFileSync(new URL(`../../src/test/contract/${name}.json`, import.meta.url), 'utf8')) as { example: T };
  return env.example;
}

type Status = 'queued' | 'classifying' | 'extracting' | 'needs_review';

/** The test document in one processing state (wire shape, GET /documents/{id} and document.updated). */
export function liveDocument(status: Status): WireDocument & Record<string, unknown> {
  const base = example<WireDocument & Record<string, unknown>>('document');
  const total = base.pages.length;
  const progress = {
    queued: null,
    classifying: { pages_total: total, pages_classified: 1, pages_ocr_total: 0, pages_ocr_done: 0, boreholes_extracted: 0 },
    extracting: { pages_total: total, pages_classified: total, pages_ocr_total: 2, pages_ocr_done: 1, boreholes_extracted: 0 },
    needs_review: { pages_total: total, pages_classified: total, pages_ocr_total: 2, pages_ocr_done: 2, boreholes_extracted: 1 },
  }[status];
  return {
    ...base,
    document_id: LIVE_DOC,
    file_name: LIVE_FILE,
    project: 'Live Updates (fictional)',
    status,
    error: null,
    duplicate_of: null,
    open_clarifications: 0,
    pages: status === 'queued' ? [] : base.pages,
    page_count: status === 'queued' ? null : total,
    progress,
    found: status === 'needs_review' ? { boreholes: 1, layers: 2, spt: 0, groundwater: 0 } : null,
    completeness:
      status === 'needs_review' ? { expected_ids: [LIVE_BOREHOLE_ID], found_ids: [LIVE_BOREHOLE_ID], missing: [], unexpected: [] } : null,
  };
}

/** The test borehole as the server would hold it after extraction (GET /boreholes/{uid}). */
export function liveBorehole(): WireRecord & Record<string, unknown> {
  const base = example<WireRecord & Record<string, unknown>>('borehole');
  return {
    ...base,
    uid: LIVE_UID,
    document_id: LIVE_DOC,
    source_file: LIVE_FILE,
    revision: 1,
    metadata: { ...base.metadata, borehole_id: LIVE_BOREHOLE_ID },
  };
}

/** One server-sent event: id, type and one data line, then a blank line. */
export function sseEvent(id: number, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A recorded stream body: the reconnect delay, a comment and the events. */
export function sseBody(retryMs: number, events: string[]): string {
  return `retry: ${retryMs}\n: connected\n\n${events.join('')}`;
}

/** A 1×1 light-grey PNG for page images of the test document. */
export const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
  'base64',
);
