import { useEffect, useRef, type MouseEvent } from 'react';
import { AddColumnMenu, RemovableHeader, useColumns } from '../../components/ColumnChooser';
import { StatusChip } from '../../components/StatusChip';
import { FIELDS, fieldByKey, type FieldDef } from '../../domain/fields';
import { useT } from '../../i18n';
import type { Borehole, BoreholeStatus } from '../../domain/types';
import type { NotOnMapReason } from './mapModel';
import styles from './ResultsTable.module.css';

interface Props {
  boreholes: Borehole[];
  statuses: Map<string, BoreholeStatus>;
  /** Why a row isn't on the map, by uid; rows without an entry are on the map. */
  notOnMap: Map<string, NotOnMapReason>;
  /** The row a search points to: highlighted and scrolled into view. */
  activeUid: string | null;
  /** False when there is no borehole at all (then the empty row points to the upload). */
  anyBoreholes: boolean;
  onOpen(uid: string): void;
}

/** Shown until the user picks others: final depth, CRS status and CRS. */
const DEFAULT_COLUMNS = ['boreholes.borehole_depth', 'boreholes.crs_status', 'boreholes.coordinate_system'];
/** Narrowest widths (px) of the columns that are always there. */
const FIXED_MIN = { borehole: 90, project: 180, status: 170, action: 120 };
/** The table's side padding (2 × --space-3). */
const TABLE_PADDING = 24;
const STORAGE_KEY = 'bormisu.listColumns.v2';

/**
 * The LIST table: BOREHOLE, PROJECT and STATUS (with NOT ON MAP and its reason), then the columns the user
 * picked (× removes one, + adds one). Every row opens the borehole's detail; for the keyboard and screen
 * readers each row has an OPEN DETAIL › button.
 */
export function ResultsTable({ boreholes, statuses, notOnMap, activeUid, anyBoreholes, onOpen }: Props) {
  const [keys, setKeys] = useColumns(STORAGE_KEY, DEFAULT_COLUMNS, (k) => fieldByKey.has(k));
  const t = useT();
  const shown = keys.map((k) => fieldByKey.get(k)!);
  const hidden = FIELDS.filter((f) => !keys.includes(f.key));
  // Every column gets an equal share of the width, never less than its minimum: few columns spread out,
  // more columns move closer, and past the screen width the table gets wider and LIST scrolls sideways.
  const mins = [FIXED_MIN.borehole, FIXED_MIN.project, FIXED_MIN.status, ...shown.map((c) => c.min), FIXED_MIN.action];
  const grid = { gridTemplateColumns: mins.map((m) => `minmax(${m}px, 1fr)`).join(' ') };
  const minWidth = mins.reduce((a, m) => a + m, 0) + TABLE_PADDING;

  return (
    <section className={styles.results} aria-label="Boreholes">
      <div className={styles.scroll} role="table" aria-label="Boreholes" style={{ minWidth }}>
        <div className={`${styles.row} ${styles.header}`} role="row" style={grid}>
          {['BOREHOLE', 'PROJECT', 'STATUS'].map((c) => (
            <div key={c} className={styles.cell} role="columnheader">{t(c)}</div>
          ))}
          {shown.map((c) => (
            <RemovableHeader key={c.key} className={styles.cell} label={c.label} title={`${c.group} · ${c.column}`}
              onRemove={() => setKeys(keys.filter((k) => k !== c.key))} />
          ))}
          <div className={`${styles.cell} ${styles.addCell}`} role="columnheader" aria-label={t('Add a column')}>
            <AddColumnMenu hidden={hidden.map((f) => ({ key: f.key, label: f.label, group: f.group, title: f.column }))}
              onAdd={(k) => setKeys([...keys, k])} />
          </div>
        </div>
        {boreholes.length === 0 && (
          <div className={styles.empty} role="row">
            <div role="cell">{t(anyBoreholes ? 'No borehole matches the search.' : 'No boreholes yet. Upload a report under UPLOAD & QUEUE.')}</div>
          </div>
        )}
        {boreholes.map((b) => (
          <ResultRow key={b.uid} borehole={b} status={statuses.get(b.uid) ?? 'unreviewed'} notOnMap={notOnMap.get(b.uid) ?? null}
            active={b.uid === activeUid} columns={shown} grid={grid} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

interface RowProps {
  borehole: Borehole;
  status: BoreholeStatus;
  notOnMap: NotOnMapReason | null;
  active: boolean;
  columns: readonly FieldDef[];
  grid: { gridTemplateColumns: string };
  onOpen(uid: string): void;
}

function ResultRow({ borehole: b, status, notOnMap, active, columns, grid, onOpen }: RowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'center' });
  }, [active]);
  const onButton = (e: MouseEvent) => {
    // The row's own click would open the detail a second time.
    e.stopPropagation();
    onOpen(b.uid);
  };
  return (
    <div ref={ref} className={`${styles.row} ${styles.body} ${styles.clickable} ${active ? styles.active : ''}`} role="row"
      style={grid} data-uid={b.uid} aria-current={active || undefined} onClick={() => onOpen(b.uid)}>
      <div className={`${styles.cell} ${styles.id}`} role="cell">{b.id}</div>
      <div className={styles.cell} role="cell">{b.project}</div>
      <div className={`${styles.cell} ${styles.status}`} role="cell">
        <StatusChip status={status} />
        {notOnMap && (
          <span className={`${styles.notOnMap} ${notOnMap.warn ? styles.notOnMapWarn : ''}`} title={notOnMap.text}>
            {t('NOT ON MAP')} · {notOnMap.text}
          </span>
        )}
      </div>
      {columns.map((c) => (
        <div key={c.key} className={`${styles.cell} ${c.mono ? styles.mono : ''} ${c.warn?.(b) ? styles.warn : ''}`} role="cell">
          {c.text(b)}
        </div>
      ))}
      <div className={`${styles.cell} ${styles.actionCell}`} role="cell">
        <button type="button" className={styles.action} aria-label={`Open detail of ${b.id}`} onClick={onButton}>
          {t('OPEN DETAIL ›')}
        </button>
      </div>
    </div>
  );
}
