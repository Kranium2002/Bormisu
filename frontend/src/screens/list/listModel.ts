/**
 * Pure model of LIST (frontend_din's table on this app's data): which rows it shows (every borehole
 * the map knows, or the active result set's members, narrowed by the header search), the cells of the
 * chosen columns (from the light row, else the full record, which loads on demand), the grid widths,
 * and which full records the visible rows still need. Unit-tested.
 */
import { matchesQuery } from '../../domain/search';
import { NONE, needsRecord, type FieldCell, type FieldDef } from '../../domain/fields';
import type { Borehole } from '../../domain/types';
import type { ResultRow, SortKey } from '../map/explore/resultsModel';

/** Narrowest widths (px) of the columns that are always there. */
export const FIXED_MIN = { borehole: 110, project: 180, status: 170, action: 210 } as const;
/** The table's side padding (2 × --space-3). */
const TABLE_PADDING = 24;

/** The rows LIST shows: the given rows (all, or the result set's), those matching the header search. */
export function listRows(rows: ResultRow[], query: string): ResultRow[] {
  return rows.filter((r) => matchesQuery(r, query));
}

/**
 * The grid of the table: every column an equal share of the width, never less than its minimum. Few
 * columns spread out; past the screen's width the table gets wider and scrolls sideways.
 */
export function gridOf(fields: readonly Pick<FieldDef, 'min'>[]): { template: string; minWidth: number } {
  const mins = [FIXED_MIN.borehole, FIXED_MIN.project, FIXED_MIN.status, ...fields.map((f) => f.min), FIXED_MIN.action];
  return { template: mins.map((m) => `minmax(${m}px, 1fr)`).join(' '), minWidth: mins.reduce((a, m) => a + m, 0) + TABLE_PADDING };
}

/** The sort of a column, when it has one (columns of the light row only). */
export function sortKeyOf(key: string): SortKey | null {
  switch (key) {
    case 'boreholes.borehole_depth':
      return 'depth';
    case 'boreholes.crs_status':
    case 'boreholes.coordinate_system':
      return 'crs';
    case 'documents.file_name':
      return 'document';
    default:
      return null;
  }
}

/** A full record's load state, as the list tracks it. */
export type RecordState = 'loading' | 'failed' | undefined;

export interface ListCell extends FieldCell {
  /** loading: the record is on its way; failed: it could not be loaded. Neither shows a value. */
  state: 'ready' | 'loading' | 'failed';
}

export const CELL_LOADING = 'Loading…';
export const CELL_FAILED = 'not loaded';

/**
 * One cell: from the light row when the column has it there, else from the full record. Without the
 * record it says it is loading (or could not be loaded), never a made-up value.
 */
export function cellOf(field: FieldDef, row: ResultRow, record: Borehole | undefined, state: RecordState): ListCell {
  const light = field.light?.(row);
  if (light) return { ...light, state: 'ready' };
  if (record) return { ...field.text(record), state: 'ready' };
  return state === 'failed' ? { text: CELL_FAILED, state: 'failed' } : { text: CELL_LOADING, state: 'loading' };
}

/** True when the cell shows "not in source". */
export const isNone = (c: Pick<ListCell, 'text' | 'state'>) => c.state === 'ready' && c.text === NONE;

/**
 * The full records the shown rows still need for the chosen columns: by document (one paged request
 * each, GET /boreholes?document_id=), and single boreholes without a document. Nothing when no chosen
 * column needs a record, and nothing already asked for.
 */
export function recordsToLoad(
  rows: ResultRow[],
  fields: readonly FieldDef[],
  cached: ReadonlySet<string>,
  asked: ReadonlySet<string>,
): { documents: string[]; uids: string[] } {
  const documents = new Set<string>();
  const uids: string[] = [];
  for (const r of rows) {
    if (cached.has(r.uid) || !fields.some((f) => needsRecord(f, r))) continue;
    if (r.documentId) {
      if (!asked.has(`doc:${r.documentId}`)) documents.add(r.documentId);
    } else if (!asked.has(`uid:${r.uid}`)) uids.push(r.uid);
  }
  return { documents: [...documents], uids };
}

/** How many of the rows have no pin ("3 not on the map"); '' when all have one. */
export function notOnMapText(rows: Pick<ResultRow, 'onMap'>[]): string {
  const off = rows.filter((r) => !r.onMap).length;
  return off ? `${off} not on the map` : '';
}
