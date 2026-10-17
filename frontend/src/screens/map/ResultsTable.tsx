/**
 * RESULTS table under the map (FRONTEND.md F9, LGRB's table under the "Bohrpunktkarte"): every
 * borehole the map knows, or the active result set's members. Columns: borehole, project, final
 * depth ("not stated" when the source gives none), status chip, CRS, document.
 *
 * - Sorting: each column header is a button; the sorted column carries aria-sort.
 * - Pages of 100 rows, so 5,000 boreholes stay responsive; each row keeps its position (aria-rowindex).
 * - Every row opens Detail (click, or Enter on the focused row). MAP (or Space on the row) selects the
 *   borehole on the map: the map shows it and opens its popup. Arrow keys, Home and End move between
 *   rows. This is the keyboard path for every map action (FRONTEND.md section 6).
 * - The row of the borehole selected on the map is marked current; when the map's selection changes,
 *   the table goes to its page and scrolls the row into view (its own scroll box only, never the page).
 * - The count is announced politely.
 */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { StatusChip } from '../../components/StatusChip';
import {
  crsColumn,
  depthCell,
  nextSort,
  PAGE_SIZE,
  pageCount,
  pageOf,
  pageOfUid,
  sortRows,
  type ResultRow,
  type Sort,
  type SortKey,
} from './explore/resultsModel';
import { resultsSummary } from './mapModel';
import styles from './ResultsTable.module.css';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'id', label: 'BOREHOLE' },
  { key: 'project', label: 'PROJECT' },
  { key: 'depth', label: 'FINAL DEPTH' },
  { key: 'status', label: 'STATUS' },
  { key: 'crs', label: 'CRS' },
  { key: 'document', label: 'DOCUMENT' },
];

export const NO_BOREHOLES = 'No boreholes yet. Upload a report under UPLOAD & QUEUE.';
const KEYS_HELP = 'Enter opens the detail. Space shows the borehole on the map. Arrow keys move between rows.';

export interface ResultsTableViewProps {
  /** Every row, in display order (sorted); the view shows one page of them. */
  rows: ResultRow[];
  /** Page shown (0-based). */
  page: number;
  sort: Sort | null;
  /** The borehole selected on the map. */
  selectedUid: string | null;
  /** Count line, announced politely. */
  summary: string;
  /** Text of an empty table. */
  empty?: string;
  /** Shown under the title (the active result set). */
  extra?: ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
  onSort(key: SortKey): void;
  onPage(page: number): void;
  onOpen(uid: string): void;
  /** Selects the borehole on the map (its popup opens). */
  onShow(uid: string): void;
}

/** The rows of the page the focus is in. */
const pageRows = (from: HTMLElement) =>
  [...(from.parentElement?.children ?? [])].filter((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.uid != null);

function moveFocus(e: KeyboardEvent<HTMLElement>, where: 'next' | 'prev' | 'first' | 'last'): void {
  const rows = pageRows(e.currentTarget);
  const i = rows.indexOf(e.currentTarget);
  const target = where === 'first' ? rows[0] : where === 'last' ? rows[rows.length - 1] : rows[where === 'next' ? i + 1 : i - 1];
  if (!target) return;
  e.preventDefault();
  target.focus();
}

function ResultRowView({ row, index, selected, onOpen, onShow }: { row: ResultRow; index: number; selected: boolean; onOpen(uid: string): void; onShow(uid: string): void }) {
  const crs = crsColumn(row.crs);
  const depth = depthCell(row.depth);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(row.uid);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (row.onMap) onShow(row.uid);
    } else if (e.key === 'ArrowDown') moveFocus(e, 'next');
    else if (e.key === 'ArrowUp') moveFocus(e, 'prev');
    else if (e.key === 'Home') moveFocus(e, 'first');
    else if (e.key === 'End') moveFocus(e, 'last');
  };
  return (
    <div
      className={`${styles.row} ${styles.body} ${styles.clickable} ${selected ? styles.selected : ''}`}
      role="row"
      aria-rowindex={index + 2}
      data-uid={row.uid}
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-describedby="results-keys"
      onClick={() => onOpen(row.uid)}
      onKeyDown={onKeyDown}
    >
      <div className={`${styles.cell} ${styles.id}`} role="cell">
        {row.id}
      </div>
      <div className={`${styles.cell} ${styles.project}`} role="cell">
        {row.project}
      </div>
      <div className={`${styles.cell} ${styles.depth} ${depth.stated ? styles.mono : styles.notStated}`} role="cell">
        {depth.text}
      </div>
      <div className={`${styles.cell} ${styles.status}`} role="cell">
        <StatusChip status={row.status} />
      </div>
      <div className={`${styles.cell} ${styles.crs} ${crs.warn ? styles.warn : styles.muted}`} role="cell" title={crs.title}>
        {crs.text}
      </div>
      <div className={`${styles.cell} ${styles.document} ${styles.muted}`} role="cell" title={row.document || undefined}>
        {row.document}
      </div>
      <div className={`${styles.cell} ${styles.actions}`} role="cell">
        {row.onMap ? (
          <button
            type="button"
            className={styles.map}
            aria-label={`Show ${row.id} on the map`}
            onClick={(e) => {
              e.stopPropagation();
              onShow(row.uid);
            }}
          >
            MAP
          </button>
        ) : (
          <span className={styles.offMap}>not on map</span>
        )}
        <span className={styles.open}>OPEN DETAIL ›</span>
      </div>
    </div>
  );
}

/** The table, from props (server-rendered in tests). */
export function ResultsTableView({ rows, page, sort, selectedUid, summary, empty = NO_BOREHOLES, extra, scrollRef, onSort, onPage, onOpen, onShow }: ResultsTableViewProps) {
  const pages = pageCount(rows.length);
  const shown = Math.min(Math.max(0, page), pages - 1);
  const start = shown * PAGE_SIZE;
  const visible = pageOf(rows, shown);
  return (
    <section className={styles.results} aria-labelledby="results-title">
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <h2 id="results-title" className={styles.title}>
            RESULTS
          </h2>
          {/* The count changes as filters run and documents finish: screen readers hear it (FRONTEND.md section 6). */}
          <div className={styles.summary} aria-live="polite">
            {summary}
          </div>
        </div>
        {extra}
      </div>
      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.table} role="table" aria-labelledby="results-title" aria-rowcount={rows.length + 1}>
          <div role="rowgroup" className={styles.headGroup} data-results-header="">
            <div className={`${styles.row} ${styles.header}`} role="row" aria-rowindex={1}>
              {COLUMNS.map((c) => {
                const sorted = sort?.key === c.key ? sort.dir : null;
                return (
                  <div
                    key={c.key}
                    className={`${styles.cell} ${styles[c.key]}`}
                    role="columnheader"
                    aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    <button type="button" className={styles.sort} onClick={() => onSort(c.key)}>
                      {c.label}
                      {sorted && (
                        <span className={styles.arrow} aria-hidden="true">
                          {sorted === 'asc' ? '▲' : '▼'}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
              <div className={`${styles.cell} ${styles.actions}`} role="columnheader" aria-label="Actions" />
            </div>
          </div>
          <div role="rowgroup">
            {rows.length === 0 && (
              <div className={styles.empty} role="row">
                <div role="cell">{empty}</div>
              </div>
            )}
            {visible.map((r, i) => (
              <ResultRowView key={r.uid} row={r} index={start + i} selected={r.uid === selectedUid} onOpen={onOpen} onShow={onShow} />
            ))}
          </div>
        </div>
      </div>
      {pages > 1 && (
        <nav className={styles.pager} aria-label="Result pages">
          <span className={styles.range}>{`Rows ${start + 1}–${start + visible.length} of ${rows.length}`}</span>
          <button type="button" className={styles.pageButton} disabled={shown === 0} onClick={() => onPage(shown - 1)}>
            ‹ PREVIOUS
          </button>
          <span className={styles.pageNo}>{`Page ${shown + 1} of ${pages}`}</span>
          <button type="button" className={styles.pageButton} disabled={shown === pages - 1} onClick={() => onPage(shown + 1)}>
            NEXT ›
          </button>
        </nav>
      )}
      <p id="results-keys" className={styles.srOnly}>
        {KEYS_HELP}
      </p>
    </section>
  );
}

/** Scrolls the table's own box so the row is visible below the sticky header (never the page). */
function scrollRowIntoView(box: HTMLElement, row: HTMLElement): void {
  const header = box.querySelector('[data-results-header]')?.getBoundingClientRect().height ?? 0;
  const b = box.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top < b.top + header) box.scrollTop -= b.top + header - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
}

interface Props {
  /** The rows to show, in the server's order (the table sorts them). */
  rows: ResultRow[];
  selectedUid: string | null;
  /** Changes when another set of rows is shown (a result set, or none): back to the first page. */
  resetKey: string;
  empty?: string;
  extra?: ReactNode;
  onOpen(uid: string): void;
  onShow(uid: string): void;
}

/** The table with its sort, page and selection-following state. */
export function ResultsTable({ rows, selectedUid, resetKey, empty, extra, onOpen, onShow }: Props) {
  const [sort, setSort] = useState<Sort | null>(null);
  const [page, setPage] = useState(0);
  const [shownKey, setShownKey] = useState(resetKey);
  if (shownKey !== resetKey) {
    setShownKey(resetKey);
    setPage(0);
  }
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const summary = useMemo(() => resultsSummary(rows), [rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The sorted rows, for the selection effect (which runs only when the selection changes). */
  const latest = useRef(sorted);
  useLayoutEffect(() => {
    latest.current = sorted;
  }, [sorted]);
  /** The selected borehole whose row is still to be scrolled into view. */
  const pending = useRef<string | null>(null);

  const scrollPending = () => {
    const uid = pending.current;
    const box = scrollRef.current;
    if (!uid || !box) return;
    const row = [...box.querySelectorAll<HTMLElement>('[data-uid]')].find((el) => el.dataset.uid === uid);
    if (!row) return;
    pending.current = null;
    scrollRowIntoView(box, row);
  };

  // The map's selection changed: go to its page, then scroll its row into view.
  useLayoutEffect(() => {
    const p = pageOfUid(latest.current, selectedUid);
    if (p == null) return;
    pending.current = selectedUid;
    setPage(p);
    scrollPending();
  }, [selectedUid]);
  useLayoutEffect(scrollPending, [page, sorted]);

  return (
    <ResultsTableView
      rows={sorted}
      page={page}
      sort={sort}
      selectedUid={selectedUid}
      summary={summary}
      empty={empty}
      extra={extra}
      scrollRef={scrollRef}
      onSort={(key) => {
        setSort((s) => nextSort(s, key));
        setPage(0);
      }}
      onPage={setPage}
      onOpen={onOpen}
      onShow={onShow}
    />
  );
}
