/**
 * Pure model of the RESULTS table under the map (FRONTEND.md F9, F10): the rows it shows (every
 * borehole the map knows, or the active result set's members), sorting by column, pages of 100
 * rows, the CRS column and the result-set summary line. Unit-tested.
 *
 * A plotted borehole comes from the light map layer (its full record only when it is cached and as
 * new); an unplotted one from its full record, which the boot loads for NOT ON MAP. Nothing is
 * invented: an unknown depth stays "not stated", a pin without its record shows only the CRS status
 * the server sent.
 */
import { crsLabel, metres } from '../../../domain/format';
import type { Borehole, BoreholeStatus, DocumentSummary, MapFeature, ResultSet } from '../../../domain/types';
import { featureRow, recordRow, type MapRow } from '../mapModel';

/** One row of the RESULTS table. */
export interface ResultRow extends MapRow {
  documentId: string | null;
  /** The document's file name; '' when the app knows neither the document nor the record's file. */
  document: string;
  /** True when the borehole has a pin (the map can show it). */
  onMap: boolean;
}

/** Rows per page (FRONTEND.md F9: 5,000 rows stay responsive). */
export const PAGE_SIZE = 100;

type Docs = Pick<DocumentSummary, 'id' | 'name'>[];

function documentNames(documents: Docs): Map<string, string> {
  return new Map(documents.map((d) => [d.id, d.name]));
}

function withDocument(row: MapRow, documentId: string | null, names: Map<string, string>, record?: Borehole): ResultRow {
  const document = (documentId ? names.get(documentId) : undefined) ?? record?.sourceFile ?? '';
  return { ...row, documentId, document, onMap: row.pin != null };
}

/** The row of a plotted feature; its cached full record (when as new) gives status, depth and CRS. */
function pinRow(f: MapFeature, record: Borehole | undefined, names: Map<string, string>): ResultRow {
  return withDocument(featureRow(f, record), f.documentId, names, record);
}

/** The row of an unplotted full record. */
function offRow(b: Borehole, names: Map<string, string>): ResultRow {
  return withDocument(recordRow(b), b.documentId, names, b);
}

/** Every borehole the map knows: each pin, then each unplotted record (NOT ON MAP), each once. */
export function allRows(features: MapFeature[], boreholes: Borehole[], unplottedUids: string[], documents: Docs): ResultRow[] {
  const names = documentNames(documents);
  const byUid = new Map(boreholes.map((b) => [b.uid, b]));
  const pins = features.map((f) => pinRow(f, byUid.get(f.uid), names));
  const pinned = new Set(pins.map((r) => r.uid));
  const off = unplottedUids
    .filter((uid) => !pinned.has(uid))
    .map((uid) => byUid.get(uid))
    .filter((b): b is Borehole => !!b)
    .map((b) => offRow(b, names));
  return [...pins, ...off];
}

/**
 * The active result set's members in the set's order: plotted members from the set's features (else
 * the map layer's), unplotted ones from their records. A member the app holds nothing of is left out;
 * the summary line keeps the server's counts.
 */
export function resultSetRows(
  rs: Pick<ResultSet, 'uids'>,
  setFeatures: MapFeature[],
  features: MapFeature[],
  boreholes: Borehole[],
  documents: Docs,
): ResultRow[] {
  const names = documentNames(documents);
  const byUid = new Map(boreholes.map((b) => [b.uid, b]));
  const pinOf = new Map(features.map((f) => [f.uid, f]));
  for (const f of setFeatures) pinOf.set(f.uid, f);
  const rows: ResultRow[] = [];
  const seen = new Set<string>();
  for (const uid of rs.uids) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    const f = pinOf.get(uid);
    const record = byUid.get(uid);
    if (f) rows.push(pinRow(f, record, names));
    else if (record) rows.push(offRow(record, names));
  }
  return rows;
}

/* ---------- sorting ---------- */

export type SortKey = 'id' | 'project' | 'depth' | 'status' | 'crs' | 'document';
export interface Sort { key: SortKey; dir: 'asc' | 'desc' }

/** Status order: what needs work first. */
const STATUS_RANK: Record<BoreholeStatus, number> = { attention: 0, unreviewed: 1, in_review: 2, approved: 3 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A sort value: text, number, or null for unknown or blank (sorted last in both directions). */
function sortValue(r: ResultRow, key: SortKey): string | number | null {
  switch (key) {
    case 'id':
      return r.id || null;
    case 'project':
      return r.project || null;
    case 'depth':
      return depthCell(r.depth).stated ? r.depth : null;
    case 'status':
      return STATUS_RANK[r.status];
    case 'crs':
      return crsColumn(r.crs).text;
    case 'document':
      return r.document || null;
  }
}

/**
 * The rows sorted by a column; null keeps the server's order. Unknown values (a depth not stated, a
 * blank project) go last whichever the direction; ties keep the server's order.
 */
export function sortRows(rows: ResultRow[], sort: Sort | null): ResultRow[] {
  if (!sort) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const keyed = rows.map((r) => ({ r, v: sortValue(r, sort.key) }));
  keyed.sort((a, b) => {
    if (a.v == null || b.v == null) return a.v == null ? (b.v == null ? 0 : 1) : -1;
    const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : collator.compare(String(a.v), String(b.v));
    return sign * c;
  });
  return keyed.map((k) => k.r);
}

/** A header click: ascending first, the same column again flips the direction. */
export function nextSort(current: Sort | null, key: SortKey): Sort {
  if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

/* ---------- pages ---------- */

export function pageCount(rows: number): number {
  return Math.max(1, Math.ceil(rows / PAGE_SIZE));
}

/** One page of rows (0-based); a page past the end shows the last one. */
export function pageOf<T>(rows: T[], page: number): T[] {
  const p = Math.min(Math.max(0, page), pageCount(rows.length) - 1);
  return rows.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
}

/** The page (0-based) that holds a borehole, or null. */
export function pageOfUid(rows: Pick<ResultRow, 'uid'>[], uid: string | null): number | null {
  if (!uid) return null;
  const i = rows.findIndex((r) => r.uid === uid);
  return i < 0 ? null : Math.floor(i / PAGE_SIZE);
}

/* ---------- cells ---------- */

export interface DepthCell {
  text: string;
  /** False for a depth the source does not state (shown grey italic, never as 0). */
  stated: boolean;
}

/** Final depth as "18.00 m", or "not stated". */
export function depthCell(depth: number | null): DepthCell {
  return depth != null && Number.isFinite(depth) && depth > 0 ? { text: metres(depth), stated: true } : { text: 'not stated', stated: false };
}

export interface CrsColumn {
  /** The server's status word, then the system's name when the app has the record: "confirmed · EPSG:2193". */
  text: string;
  /** Amber: inferred or unknown, so the position is not confirmed. */
  warn: boolean;
  /** Hover text. It never says "no coordinate system" for a stated or confirmed one. */
  title: string;
}

const CRS_TITLE: Record<Borehole['crs']['status'], string> = {
  stated: 'Coordinate system stated in the source',
  inferred: 'Coordinate system inferred, not stated in the source',
  confirmed: 'Coordinate system confirmed by a reviewer',
  unknown: 'Coordinate system unknown',
};

/**
 * CRS column: the status word, then the system's name: the server's label (the map layer carries it
 * since 1.2.0, a full record since 1.1.0), else the name as printed, else the code. Without any of
 * them only the status shows, and the title says only what the status means.
 */
export function crsColumn(crs: Borehole['crs']): CrsColumn {
  const label = crsLabel(crs);
  const name = crs.label?.trim() || crs.name?.trim();
  const full = name ? `${name}${crs.code?.trim() ? ` (${crs.code.trim()})` : ''}` : label;
  return {
    text: label ? `${crs.status} · ${label}` : crs.status,
    warn: crs.status === 'inferred' || crs.status === 'unknown',
    title: full ? `${CRS_TITLE[crs.status]}: ${full}` : CRS_TITLE[crs.status],
  };
}

/* ---------- summaries ---------- */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The active result set in one line, from the server's counts: "7 boreholes · 6 on the map ·
 * 1 not located · 0 unreviewed left out" (the last part only when the server counted it).
 */
export function resultSetSummary(rs: Pick<ResultSet, 'count' | 'locatedCount' | 'unlocatedCount' | 'excludedUnreviewed'>): string {
  const parts = [plural(rs.count, 'borehole', 'boreholes'), `${rs.locatedCount} on the map`, `${rs.unlocatedCount} not located`];
  if (rs.excludedUnreviewed != null) parts.push(`${rs.excludedUnreviewed} unreviewed left out`);
  return parts.join(' · ');
}
