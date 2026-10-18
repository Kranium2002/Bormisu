/**
 * LIST (/list): every borehole the map knows in one table (frontend_din), those without a pin with
 * their reason (NOT ON MAP). The filters and the area of the map apply here too: while a result set is
 * active the table shows its members, with "FILTERED · N boreholes" and CLEAR above it. The header
 * search narrows the rows as it is typed.
 *
 * Columns beyond the map layer's need the full records: the visible page's are loaded on demand
 * through the store (a document's records in one paged request, GET /boreholes?document_id=), and
 * stay cached for Detail and Review.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldDef } from '../../domain/fields';
import { isFilterQuery } from '../../domain/search';
import { useAppStore } from '../../store/appStore';
import { ResultSetSummary } from '../map/explore/ResultSetSummary';
import { allRows, resultSetRows, type ResultRow } from '../map/explore/resultsModel';
import { listRows, recordsToLoad, type RecordState } from './listModel';
import styles from './ListScreen.module.css';
import { ListTable, NO_BOREHOLES, NO_MATCH_SEARCH, type Pointed } from './ListTable';
import { ReportButton } from '../../report/ReportButton';

/** Empty table while a result set is active: it has no member, or none the app holds (deleted meanwhile). */
const NO_MATCH = 'No borehole matches this selection.';
const NOT_LOADED = 'No borehole of this result set is loaded.';
/** How long the rows a queue card's WHY pointed at stay highlighted. */
const POINTED_MS = 4000;
/** The nonce of the last WHY handled, also across remounts. */
let handledFocus: number | null = null;

export function ListScreen() {
  const features = useAppStore((s) => s.features);
  const boreholes = useAppStore((s) => s.boreholes);
  const unplottedUids = useAppStore((s) => s.unplottedUids);
  const documents = useAppStore((s) => s.documents);
  const selectedUid = useAppStore((s) => s.selectedUid);
  const query = useAppStore((s) => s.query);
  const resultSet = useAppStore((s) => s.resultSet);
  const resultSetFeatures = useAppStore((s) => s.resultSetFeatures);
  const resultSetBusy = useAppStore((s) => s.resultSetBusy);
  const resultSetError = useAppStore((s) => s.resultSetError);
  const notOnMapFocus = useAppStore((s) => s.notOnMapFocus);
  const openBorehole = useAppStore((s) => s.openBorehole);
  const showOnMap = useAppStore((s) => s.focusChatBorehole);
  const clearResultSet = useAppStore((s) => s.clearResultSet);
  const ensureDocumentBoreholes = useAppStore((s) => s.ensureDocumentBoreholes);
  const ensureBorehole = useAppStore((s) => s.ensureBorehole);

  const base = useMemo(
    () =>
      resultSet && resultSetFeatures
        ? resultSetRows(resultSet, resultSetFeatures, features, boreholes, documents)
        : allRows(features, boreholes, unplottedUids, documents),
    [resultSet, resultSetFeatures, features, boreholes, unplottedUids, documents],
  );
  const rows = useMemo(() => listRows(base, query), [base, query]);
  const records = useMemo(() => new Map(boreholes.map((b) => [b.uid, b])), [boreholes]);

  /* ---------- full records on demand ---------- */

  // Asked for ("doc:<id>" / "uid:<uid>") and failed, kept across renders; `version` re-renders on a change.
  const asked = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const done = useRef(new Set<string>());
  const [, setVersion] = useState(0);
  const latestRecords = useRef(records);
  latestRecords.current = records;

  const onVisible = useCallback(
    (visible: ResultRow[], columns: readonly FieldDef[]) => {
      const cached = new Set(latestRecords.current.keys());
      const need = recordsToLoad(visible, columns, cached, asked.current);
      const fail = (id: string) => {
        failed.current.add(id);
        setVersion((v) => v + 1);
      };
      for (const d of need.documents) {
        const id = `doc:${d}`;
        asked.current.add(id);
        ensureDocumentBoreholes(d).then(
          () => {
            done.current.add(id);
            setVersion((v) => v + 1);
          },
          () => fail(id),
        );
      }
      for (const uid of need.uids) {
        const id = `uid:${uid}`;
        asked.current.add(id);
        ensureBorehole(uid).then(
          (b) => (b ? setVersion((v) => v + 1) : fail(id)),
          () => fail(id),
        );
      }
    },
    [ensureDocumentBoreholes, ensureBorehole],
  );

  /** The state of a record that is not cached: failed, or its document's records came without it. */
  const recordState = (r: ResultRow): RecordState => {
    const id = r.documentId ? `doc:${r.documentId}` : `uid:${r.uid}`;
    return failed.current.has(id) || done.current.has(id) ? 'failed' : 'loading';
  };

  /* ---------- a queue card's WHY ---------- */

  const [pointed, setPointed] = useState<Pointed | null>(null);
  useEffect(() => {
    if (!notOnMapFocus || handledFocus === notOnMapFocus.nonce) return;
    handledFocus = notOnMapFocus.nonce;
    const off = rows.filter((r) => !r.onMap && (!notOnMapFocus.documentId || r.documentId === notOnMapFocus.documentId));
    const next: Pointed = { uids: new Set(off.map((r) => r.uid)), first: off[0]?.uid ?? null, nonce: notOnMapFocus.nonce };
    setPointed(next);
    const timer = setTimeout(() => setPointed((p) => (p?.nonce === next.nonce ? null : p)), POINTED_MS);
    return () => clearTimeout(timer);
  }, [notOnMapFocus, rows]);

  const empty = resultSet ? (resultSet.count === 0 ? NO_MATCH : NOT_LOADED) : isFilterQuery(query) && base.length > 0 ? NO_MATCH_SEARCH : NO_BOREHOLES;

  return (
    <div className={styles.screen} data-screen-label="List">
      <ListTable
        rows={rows}
        records={records}
        recordState={recordState}
        selectedUid={selectedUid}
        pointed={pointed}
        resetKey={`${resultSet?.id ?? 'all'}|${query.trim()}`}
        empty={empty}
        extra={
          <>
            <ResultSetSummary resultSet={resultSet} busy={resultSetBusy} error={resultSetError} onClear={clearResultSet} />
            {rows.length > 0 && <ReportButton scope="list" query={query} className={styles.report} />}
          </>
        }
        onVisible={onVisible}
        onOpen={openBorehole}
        onShow={showOnMap}
      />
    </div>
  );
}
