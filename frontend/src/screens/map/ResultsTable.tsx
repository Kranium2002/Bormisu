import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { StatusChip } from '../../components/StatusChip';
import { metres } from '../../domain/format';
import { useT } from '../../i18n';
import type { Borehole, BoreholeStatus } from '../../domain/types';
import { crsCell, depthText, type NotOnMapReason } from './mapModel';
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

/** A column the user can add or remove (BOREHOLE, PROJECT and STATUS always stay). */
interface Column { key: string; label: string; width: string; cell(b: Borehole): ReactNode }

const num = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? metres(v) : '–');
const OPTIONAL: readonly Column[] = [
  { key: 'depth', label: 'FINAL DEPTH', width: '110px', cell: (b) => <span className={styles.mono}>{depthText(b)}</span> },
  {
    key: 'crs', label: 'CRS', width: 'minmax(150px, 1fr)', cell: (b) => {
      const c = crsCell(b.crs);
      return <span className={c.warn ? styles.warn : styles.muted} title={c.title}>{c.text}</span>;
    },
  },
  { key: 'rock', label: 'ROCK HEAD', width: '110px', cell: (b) => <span className={styles.mono}>{num(b.rockHead)}</span> },
  { key: 'layers', label: 'LAYERS', width: '80px', cell: (b) => <span className={styles.mono}>{b.layers.length}</span> },
  {
    key: 'gw', label: 'GROUNDWATER', width: '120px',
    cell: (b) => <span className={styles.mono}>{num((b.groundwater.find((g) => g.type === 'strike') ?? b.groundwater[0])?.depth)}</span>,
  },
  { key: 'tests', label: 'TEST RESULTS', width: '110px', cell: (b) => <span className={styles.mono}>{b.testResults?.length ?? 0}</span> },
  {
    key: 'coords', label: 'COORDINATES', width: '170px',
    cell: (b) => <span className={styles.mono}>{b.lat != null && b.lng != null ? `${b.lat.toFixed(4)}, ${b.lng.toFixed(4)}` : '–'}</span>,
  },
  { key: 'file', label: 'SOURCE FILE', width: 'minmax(140px, 1fr)', cell: (b) => <span className={styles.muted}>{b.sourceFile || '–'}</span> },
];
const DEFAULT_COLUMNS = ['depth', 'crs'];
const STORAGE_KEY = 'bormisu.listColumns';

/** The chosen optional columns, remembered in this browser (a convenience: falls back to the default). */
function useColumns(): [string[], (keys: string[]) => void] {
  const [keys, setKeys] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (Array.isArray(saved)) return saved.filter((k) => OPTIONAL.some((c) => c.key === k));
    } catch {
      // no storage (private window, blocked site data): the default
    }
    return DEFAULT_COLUMNS;
  });
  const save = (next: string[]) => {
    setKeys(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // not remembered, still shown
    }
  };
  return [keys, save];
}

/**
 * The LIST table: BOREHOLE, PROJECT and STATUS (with NOT ON MAP and its reason), then the columns the user
 * picked (× removes one, + adds one). Every row opens the borehole's detail; for the keyboard and screen
 * readers each row has an OPEN DETAIL › button.
 */
export function ResultsTable({ boreholes, statuses, notOnMap, activeUid, anyBoreholes, onOpen }: Props) {
  const [keys, setKeys] = useColumns();
  const t = useT();
  const shown = keys.map((k) => OPTIONAL.find((c) => c.key === k)!);
  const hidden = OPTIONAL.filter((c) => !keys.includes(c.key));
  const grid = { gridTemplateColumns: ['100px', 'minmax(0, 1.3fr)', '240px', ...shown.map((c) => c.width), '130px'].join(' ') };
  const addMenu = useRef<HTMLDetailsElement>(null);
  const add = (key: string) => {
    setKeys([...keys, key]);
    if (addMenu.current) addMenu.current.open = false;
  };

  return (
    <section className={styles.results} aria-label="Boreholes">
      <div className={styles.scroll} role="table" aria-label="Boreholes">
        <div className={`${styles.row} ${styles.header}`} role="row" style={grid}>
          {['BOREHOLE', 'PROJECT', 'STATUS'].map((c) => (
            <div key={c} className={styles.cell} role="columnheader">{t(c)}</div>
          ))}
          {shown.map((c) => (
            <div key={c.key} className={`${styles.cell} ${styles.optionalHead}`} role="columnheader">
              {t(c.label)}
              <button type="button" className={styles.removeColumn} aria-label={`Remove column ${c.label}`}
                onClick={() => setKeys(keys.filter((k) => k !== c.key))}>×</button>
            </div>
          ))}
          <div className={`${styles.cell} ${styles.addCell}`} role="columnheader" aria-label={t('Add a column')}>
            {hidden.length > 0 && (
              <details ref={addMenu} className={styles.addMenu}>
                <summary className={styles.addButton} aria-label={t('Add a column')} title={t('Add a column')}>+</summary>
                <ul className={styles.addList}>
                  {hidden.map((c) => (
                    <li key={c.key}>
                      <button type="button" className={styles.addItem} onClick={() => add(c.key)}>{t(c.label)}</button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
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
  columns: readonly Column[];
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
        <div key={c.key} className={styles.cell} role="cell">{c.cell(b)}</div>
      ))}
      <div className={`${styles.cell} ${styles.actionCell}`} role="cell">
        <button type="button" className={styles.action} aria-label={`Open detail of ${b.id}`} onClick={onButton}>
          {t('OPEN DETAIL ›')}
        </button>
      </div>
    </div>
  );
}
