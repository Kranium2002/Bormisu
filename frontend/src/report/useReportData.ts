/**
 * What /report shows, loaded from its URL alone, so a reload or a shared link gives the same report:
 *
 * 1. the selection: the result set `rs` (the active one when the store has it, else from the server;
 *    never through showResultSet, which would move to the map); with `line`, the planned line and its
 *    hits by chainage (the shown line when it is the same, else the line queried again with the URL's
 *    distance and review scope);
 * 2. the records of every member: one request per document (ensureDocumentBoreholes), single records
 *    only for members without one, a few at a time, with progress.
 *
 * Members whose record can't be loaded are left out and counted, never invented.
 */
import { useEffect, useState } from 'react';
import { errorText } from '../data/errors';
import type { Borehole, ResultSet } from '../domain/types';
import type { ReportUrlState } from '../routing/urlState';
import { useAppStore } from '../store/appStore';
import { selectionUids, type ReportSelection } from './reportModel';

export type ReportData =
  | { state: 'none' }
  | { state: 'loading'; loaded: number; total: number | null }
  | { state: 'error'; message: string }
  | { state: 'ready'; selection: ReportSelection; records: Borehole[]; missing: number };

/** Document requests in flight at once. */
const PARALLEL = 4;

/** Runs `work` over the items, at most `limit` at a time. */
async function inBatches<T>(items: readonly T[], limit: number, work: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** The selection the URL names. */
async function loadSelection(url: ReportUrlState): Promise<ReportSelection> {
  const s = useAppStore.getState();
  const source = s.source;
  if (!source) throw new Error('No data source.');
  if (url.line) {
    const shown = s.alignment?.id === url.line && s.alignmentResult?.alignmentId === url.line && (!url.rs || s.alignmentResult.resultSet.id === url.rs);
    if (shown && s.alignment && s.alignmentResult) {
      return { kind: 'line', resultSet: s.alignmentResult.resultSet, alignment: s.alignment, result: s.alignmentResult };
    }
    const alignment = await source.getAlignment(url.line);
    const result = await source.queryAlignment(url.line, { bufferM: url.buffer ?? alignment.bufferM, includeUnreviewed: url.unrev ?? true });
    return { kind: 'line', resultSet: result.resultSet, alignment, result };
  }
  if (!url.rs) throw new Error('none');
  const rs: ResultSet = s.resultSet?.id === url.rs ? s.resultSet : await source.getResultSet(url.rs);
  return rs.area ? { kind: 'area', resultSet: rs, area: rs.area } : { kind: 'set', resultSet: rs };
}

/** The document of each member, from what the store already knows (map features, cached records, line hits). */
function documentsOf(uids: readonly string[], selection: ReportSelection): Map<string, string[]> {
  const s = useAppStore.getState();
  const doc = new Map<string, string | null>();
  for (const f of s.features) doc.set(f.uid, f.documentId);
  for (const b of s.boreholes) doc.set(b.uid, b.documentId);
  if (selection.kind === 'line') for (const h of selection.result.hits) doc.set(h.uid, h.documentId);
  const byDocument = new Map<string, string[]>();
  for (const uid of uids) {
    const d = doc.get(uid);
    if (d) byDocument.set(d, [...(byDocument.get(d) ?? []), uid]);
  }
  return byDocument;
}

export function useReportData(url: ReportUrlState): ReportData {
  const [data, setData] = useState<ReportData>(() => (url.rs || url.line ? { state: 'loading', loaded: 0, total: null } : { state: 'none' }));
  const { rs, line, buffer, unrev } = url;

  useEffect(() => {
    if (!rs && !line) {
      setData({ state: 'none' });
      return;
    }
    let live = true;
    setData({ state: 'loading', loaded: 0, total: null });
    void (async () => {
      let selection: ReportSelection;
      try {
        selection = await loadSelection({ rs, line, buffer, unrev });
      } catch (e) {
        if (live) setData({ state: 'error', message: errorText(e) });
        return;
      }
      const uids = selectionUids(selection);
      const cached = () => {
        const have = new Set(useAppStore.getState().boreholes.map((b) => b.uid));
        return uids.filter((u) => have.has(u)).length;
      };
      if (live) setData({ state: 'loading', loaded: cached(), total: uids.length });
      const byDocument = documentsOf(uids, selection);
      const store = useAppStore.getState();
      const have = new Set(store.boreholes.map((b) => b.uid));
      const docs = [...byDocument].filter(([, members]) => members.some((u) => !have.has(u))).map(([d]) => d);
      const tick = () => {
        if (live) setData({ state: 'loading', loaded: cached(), total: uids.length });
      };
      await inBatches(docs, PARALLEL, (d) => store.ensureDocumentBoreholes(d).finally(tick));
      // Members a document request didn't bring (or without a known document): one by one.
      const after = new Set(useAppStore.getState().boreholes.map((b) => b.uid));
      await inBatches(
        uids.filter((u) => !after.has(u)),
        PARALLEL,
        (u) => store.ensureBorehole(u).finally(tick),
      );
      if (!live) return;
      const all = new Map(useAppStore.getState().boreholes.map((b) => [b.uid, b]));
      const records = uids.map((u) => all.get(u)).filter((b): b is Borehole => !!b);
      setData({ state: 'ready', selection, records, missing: uids.length - records.length });
    })();
    return () => {
      live = false;
    };
  }, [rs, line, buffer, unrev]);

  return data;
}
