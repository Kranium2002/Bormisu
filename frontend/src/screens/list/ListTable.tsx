/**
 * The LIST table (frontend_din's ResultsTable on this app's rows): BOREHOLE, PROJECT and STATUS (with
 * NOT ON MAP and its reason for a borehole without a pin), then the columns the user picked (× removes
 * one, + adds one from every README_data field, grouped by table), then MAP and OPEN DETAIL ›.
 *
 * - The columns share the width; past the screen's width the table scrolls sideways in its own box.
 * - Columns of the map layer (final depth, CRS, the document) show at once; the others need the full
 *   record, which LIST loads on demand: such a cell says "Loading…" (its header too) until it is there,
 *   or "not loaded" when it failed. "–" is "not in source", never a guessed value.
 * - Sorting: BOREHOLE, PROJECT, STATUS and the map-layer columns; the sorted one carries aria-sort.
 * - Pages of 100 rows; each row keeps its position (aria-rowindex).
 * - Every row opens Detail (click, Enter, OPEN DETAIL ›). MAP (or Space on the row) shows the borehole
 *   on the map. Arrow keys, Home and End move between rows.
 * - The row of the borehole selected on the map is current and scrolled into view; a queue card's WHY
 *   points at its document's rows that are not on the map (highlighted, the first one focused).
 */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AddColumnMenu, useColumns } from '../../components/ColumnChooser';
import chooser from '../../components/ColumnChooser.module.css';
import { StatusChip } from '../../components/StatusChip';
import { DEFAULT_COLUMNS, FIELDS, fieldByKey, NONE_TITLE, needsRecord, type FieldDef } from '../../domain/fields';
import type { Borehole } from '../../domain/types';
import { useT } from '../../i18n';
import { nextSort, PAGE_SIZE, pageCount, pageOf, pageOfUid, sortRows, type ResultRow, type Sort, type SortKey } from '../map/explore/resultsModel';
import { notOnMapReason, resultsSummary } from '../map/mapModel';
import { cellOf, gridOf, isNone, notOnMapText, sortKeyOf, type RecordState } from './listModel';
import styles from './ListTable.module.css';

export const NO_BOREHOLES = 'No boreholes yet. Upload a report under UPLOAD & QUEUE.';
export const NO_MATCH_SEARCH = 'No borehole matches the search.';
const KEYS_HELP = 'Enter opens the detail. Space shows the borehole on the map. Arrow keys move between rows.';
/** Where the chosen columns are remembered in this browser. */
export const COLUMNS_KEY = 'bormisu.listColumns.v3';

/** The rows a queue card's WHY points at, for a moment. */
export interface Pointed { uids: ReadonlySet<string>; first: string | null; nonce: number }

const FIXED: { key: SortKey; label: string }[] = [
  { key: 'id', label: 'BOREHOLE' },
  { key: 'project', label: 'PROJECT' },
  { key: 'status', label: 'STATUS' },
];

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

/** Scrolls the table's own box so the row is visible below the sticky header (never the page). */
function scrollRowIntoView(box: HTMLElement, row: HTMLElement): void {
  const header = box.querySelector('[data-results-header]')?.getBoundingClientRect().height ?? 0;
  const b = box.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top < b.top + header) box.scrollTop -= b.top + header - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
}

interface RowProps {
  row: ResultRow;
  index: number;
  record: Borehole | undefined;
  recordState: RecordState;
  columns: readonly FieldDef[];
  grid: string;
  selected: boolean;
  pointed: boolean;
  onOpen(uid: string): void;
  onShow(uid: string): void;
}

function ListRow({ row, index, record, recordState, columns, grid, selected, pointed, onOpen, onShow }: RowProps) {
  const t = useT();
  const reason = !row.onMap && record ? notOnMapReason(record) : null;
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
      className={`${styles.row} ${styles.body} ${selected ? styles.selected : ''} ${pointed ? styles.pointed : ''}`}
      style={{ gridTemplateColumns: grid }}
      role="row"
      aria-rowindex={index + 2}
      data-uid={row.uid}
      data-document-id={row.documentId ?? undefined}
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-describedby="list-keys"
      onClick={() => onOpen(row.uid)}
      onKeyDown={onKeyDown}
    >
      <div className={`${styles.cell} ${styles.id}`} role="cell">
        {row.id}
      </div>
      <div className={styles.cell} role="cell">
        {row.project}
      </div>
      <div className={`${styles.cell} ${styles.status}`} role="cell">
        <StatusChip status={row.status} />
        {!row.onMap && (
          <span className={`${styles.notOnMap} ${reason?.warn ? styles.notOnMapWarn : ''}`} title={reason?.text}>
            {t('NOT ON MAP')}
            {reason && ` · ${t(reason.text)}`}
          </span>
        )}
      </div>
      {columns.map((c) => {
        const v = cellOf(c, row, record, recordState);
        const none = isNone(v);
        return (
          <div
            key={c.key}
            role="cell"
            className={`${styles.cell} ${c.mono && v.state === 'ready' ? styles.mono : ''} ${v.warn ? styles.warn : ''} ${v.state !== 'ready' || none ? styles.faint : ''}`}
            title={none ? t(NONE_TITLE) : undefined}
            aria-busy={v.state === 'loading' || undefined}
          >
            {v.state === 'ready' ? v.text : t(v.text)}
          </div>
        );
      })}
      <div className={`${styles.cell} ${styles.actions}`} role="cell">
        {row.onMap && (
          <button
            type="button"
            className={styles.map}
            aria-label={`Show ${row.id} on the map`}
            onClick={(e) => {
              e.stopPropagation();
              onShow(row.uid);
            }}
          >
            {t('MAP')}
          </button>
        )}
        <button
          type="button"
          className={styles.open}
          aria-label={reason ? `Open detail of ${row.id}: ${reason.text}` : `Open detail of ${row.id}`}
          onClick={(e) => {
            // The row's own click would open the detail a second time.
            e.stopPropagation();
            onOpen(row.uid);
          }}
        >
          {t('OPEN DETAIL ›')}
        </button>
      </div>
    </div>
  );
}

interface Props {
  /** The rows to show, in the server's order (the table sorts them). */
  rows: ResultRow[];
  /** Full records by uid (the cache); the chosen columns read them. */
  records: ReadonlyMap<string, Borehole>;
  /** Load state of a record that is not cached. */
  recordState(row: ResultRow): RecordState;
  selectedUid: string | null;
  pointed: Pointed | null;
  /** Changes when another set of rows is shown (a result set, a search): back to the first page. */
  resetKey: string;
  /** Text of an empty table. */
  empty: string;
  /** Under the count line: the filtered result set and CLEAR. */
  extra?: ReactNode;
  /** The visible page's rows and the chosen columns, whenever either changes (the screen loads records). */
  onVisible(rows: ResultRow[], columns: readonly FieldDef[]): void;
  onOpen(uid: string): void;
  onShow(uid: string): void;
}

export function ListTable({ rows, records, recordState, selectedUid, pointed, resetKey, empty, extra, onVisible, onOpen, onShow }: Props) {
  const t = useT();
  const [keys, setKeys] = useColumns(COLUMNS_KEY, DEFAULT_COLUMNS, (k) => fieldByKey.has(k));
  const columns = useMemo(() => keys.map((k) => fieldByKey.get(k)).filter((f): f is FieldDef => !!f), [keys]);
  const hidden = FIELDS.filter((f) => !keys.includes(f.key));
  const { template, minWidth } = gridOf(columns);
  const [sort, setSort] = useState<Sort | null>(null);
  const [page, setPage] = useState(0);
  const [shownKey, setShownKey] = useState(resetKey);
  if (shownKey !== resetKey) {
    setShownKey(resetKey);
    setPage(0);
  }
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const pages = pageCount(sorted.length);
  const shown = Math.min(Math.max(0, page), pages - 1);
  const start = shown * PAGE_SIZE;
  const visible = useMemo(() => pageOf(sorted, shown), [sorted, shown]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const latest = useRef(sorted);
  const pending = useRef<{ uid: string; focus: boolean } | null>(null);

  useLayoutEffect(() => {
    latest.current = sorted;
  }, [sorted]);

  // The screen loads the records the visible rows need for the chosen columns.
  useLayoutEffect(() => onVisible(visible, columns), [visible, columns, onVisible]);

  const scrollPending = () => {
    const p = pending.current;
    const box = scrollRef.current;
    if (!p || !box) return;
    const row = [...box.querySelectorAll<HTMLElement>('[data-uid]')].find((el) => el.dataset.uid === p.uid);
    if (!row) return;
    pending.current = null;
    scrollRowIntoView(box, row);
    if (p.focus) row.focus({ preventScroll: true });
  };

  // The map's selection, or a WHY: go to the row's page, then scroll it into view.
  const goTo = (uid: string | null, focus: boolean) => {
    const p = pageOfUid(latest.current, uid);
    if (p == null || !uid) return;
    pending.current = { uid, focus };
    setPage(p);
    scrollPending();
  };
  useLayoutEffect(() => goTo(selectedUid, false), [selectedUid]);
  useLayoutEffect(() => goTo(pointed?.first ?? null, true), [pointed]);
  useLayoutEffect(scrollPending, [shown, sorted]);

  const loadingColumn = (c: FieldDef) => visible.some((r) => needsRecord(c, r) && !records.has(r.uid) && recordState(r) !== 'failed');

  const sortHeader = (key: SortKey, label: string) => {
    const dir = sort?.key === key ? sort.dir : null;
    return {
      ariaSort: dir ? (dir === 'asc' ? ('ascending' as const) : ('descending' as const)) : undefined,
      button: (
        <button
          type="button"
          className={styles.sort}
          onClick={() => {
            setSort((s) => nextSort(s, key));
            setPage(0);
          }}
        >
          {t(label)}
          {dir && (
            <span className={styles.arrow} aria-hidden="true">
              {dir === 'asc' ? '▲' : '▼'}
            </span>
          )}
        </button>
      ),
    };
  };

  const summary = resultsSummary(rows);
  const off = notOnMapText(rows);

  return (
    <section className={styles.results} aria-labelledby="results-title">
      <div className={styles.head}>
        <h1 id="results-title" className={styles.srOnly}>
          {t('Boreholes')}
        </h1>
        {/* The count changes as filters run and documents finish: screen readers hear it. */}
        <p className={styles.summary} aria-live="polite">
          {summary}
          {off && <span className={styles.off}>{` · ${off}`}</span>}
        </p>
        {extra}
      </div>
      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.table} role="table" aria-labelledby="results-title" aria-rowcount={rows.length + 1} style={{ minWidth }}>
          <div role="rowgroup" className={styles.headGroup} data-results-header="">
            <div className={`${styles.row} ${styles.header}`} style={{ gridTemplateColumns: template }} role="row" aria-rowindex={1}>
              {FIXED.map((c) => {
                const h = sortHeader(c.key, c.label);
                return (
                  <div key={c.key} className={styles.cell} role="columnheader" aria-sort={h.ariaSort}>
                    {h.button}
                  </div>
                );
              })}
              {columns.map((c) => {
                const key = sortKeyOf(c.key);
                const h = key ? sortHeader(key, c.label) : null;
                const loading = loadingColumn(c);
                return (
                  <div
                    key={c.key}
                    className={`${styles.cell} ${styles.optional}`}
                    role="columnheader"
                    aria-sort={h?.ariaSort}
                    title={`${t(c.group)} · ${c.column}`}
                    aria-busy={loading || undefined}
                  >
                    {h ? h.button : <span className={styles.label}>{t(c.label)}</span>}
                    {loading && <span className={styles.loading}>{t('loading')}</span>}
                    <button
                      type="button"
                      className={chooser.remove}
                      aria-label={`Remove column ${c.label}`}
                      onClick={() => setKeys(keys.filter((k) => k !== c.key))}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <div className={`${styles.cell} ${styles.addCell}`} role="columnheader" aria-label={t('Add a column')}>
                <AddColumnMenu
                  hidden={hidden.map((f) => ({ key: f.key, label: f.label, group: f.group, title: f.column }))}
                  onAdd={(k) => setKeys([...keys, k])}
                />
              </div>
            </div>
          </div>
          <div role="rowgroup">
            {rows.length === 0 && (
              <div className={styles.empty} role="row">
                <div role="cell">{t(empty)}</div>
              </div>
            )}
            {visible.map((r, i) => (
              <ListRow
                key={r.uid}
                row={r}
                index={start + i}
                record={records.get(r.uid)}
                recordState={records.has(r.uid) ? undefined : recordState(r)}
                columns={columns}
                grid={template}
                selected={r.uid === selectedUid}
                pointed={!!pointed?.uids.has(r.uid)}
                onOpen={onOpen}
                onShow={onShow}
              />
            ))}
          </div>
        </div>
      </div>
      {pages > 1 && (
        <nav className={styles.pager} aria-label="Result pages">
          <span className={styles.range}>{`Rows ${start + 1}–${start + visible.length} of ${rows.length}`}</span>
          <button
            type="button"
            className={styles.pageButton}
            disabled={shown === 0}
            title={shown === 0 ? 'This is the first page' : undefined}
            onClick={() => setPage(shown - 1)}
          >
            {t('‹ PREVIOUS')}
          </button>
          <span className={styles.pageNo}>{`Page ${shown + 1} of ${pages}`}</span>
          <button
            type="button"
            className={styles.pageButton}
            disabled={shown === pages - 1}
            title={shown === pages - 1 ? 'This is the last page' : undefined}
            onClick={() => setPage(shown + 1)}
          >
            {t('NEXT ›')}
          </button>
        </nav>
      )}
      <p id="list-keys" className={styles.srOnly}>
        {KEYS_HELP}
      </p>
    </section>
  );
}
