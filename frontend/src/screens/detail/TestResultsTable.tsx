import type { KeyboardEvent } from 'react';
import { AddColumnMenu, RemovableHeader, useColumns } from '../../components/ColumnChooser';
import type { Borehole } from '../../domain/types';
import { useT } from '../../i18n';
import { testTable, type TestRow } from './detailModel';
import { ValueCell } from './ValueCell';
import card from './cards.module.css';
import styles from './TestResultsTable.module.css';

interface Props {
  borehole: Borehole;
  /** The picked sample (index into `borehole.samples`): its row is marked, as its marker in the profile. */
  selectedSample: number | null;
  /** A row click: picks its sample (if it is one) and selects the layer at its depth. */
  onSelectRow(row: TestRow): void;
  /** Opens the document view at a value. */
  onOpenSource(key: string): void;
}

/** Optional columns besides the test names: the sample type and the layer at the sample's depth. */
const TYPE = '§type';
const LAYER = '§layer';
/** Narrowest widths (px) of the columns that always stay: SAMPLE, DEPTH, +. */
const FIXED = { sample: 110, depth: 110, add: 34 };

/**
 * TEST RESULTS table: one row per sample (and per depth of results that name no listed sample), one
 * column per test the record has, each value with its status dot (a click opens the document view).
 * SAMPLE and DEPTH always stay; the others go with × and come back with + (remembered in this
 * browser as the removed ones, so a borehole with other tests still shows them).
 */
export function TestResultsTable({ borehole: b, selectedSample, onSelectRow, onOpenSource }: Props) {
  const t = useT();
  const { columns, rows } = testTable(b);
  const [removed, setRemoved] = useColumns('bormisu.detail.testColumnsRemoved', [], () => true);
  const all = [TYPE, LAYER, ...columns];
  const shown = all.filter((k) => !removed.includes(k));
  const hidden = all.filter((k) => removed.includes(k));
  const label = (k: string) => (k === TYPE ? 'TYPE' : k === LAYER ? 'LAYER' : k);
  const minOf = (k: string) => (k === TYPE ? 70 : k === LAYER ? 90 : Math.max(90, k.length * 8 + 32));
  const grid = {
    gridTemplateColumns: [`${FIXED.sample}px`, `${FIXED.depth}px`, ...shown.map((k) => `minmax(${minOf(k)}px, 1fr)`), `${FIXED.add}px`].join(' '),
  };
  const minWidth = FIXED.sample + FIXED.depth + FIXED.add + shown.reduce((a, k) => a + minOf(k), 0);
  const layerText = (n: number | null) => {
    const l = n == null ? undefined : b.layers.find((x) => x.n === n);
    return l ? `${l.n} · ${l.dinNotation || l.din || '–'}` : '–';
  };
  const onRowKey = (r: TestRow) => (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectRow(r);
    }
  };

  return (
    <section className={card.card} aria-label="Test results">
      <div className={card.head}>{t('TEST RESULTS')}</div>
      {rows.length > 0 && (
        <div className={styles.scroll}>
          <div role="grid" aria-label="Test results" style={{ minWidth }}>
            <div role="row" className={card.thead} style={grid}>
              <div role="columnheader" className={card.th}>{t('SAMPLE')}</div>
              <div role="columnheader" className={card.th}>{t('DEPTH (m)')}</div>
              {shown.map((k) => (
                <RemovableHeader key={k} className={card.th} label={label(k)} onRemove={() => setRemoved([...removed, k])} />
              ))}
              <div role="columnheader" className={`${card.th} ${styles.addCell}`} aria-label={t('Add a column')}>
                <AddColumnMenu
                  hidden={hidden.map((k) => ({ key: k, label: label(k), group: k === TYPE || k === LAYER ? 'Sample' : 'Tests' }))}
                  onAdd={(k) => setRemoved(removed.filter((x) => x !== k))}
                />
              </div>
            </div>
            {rows.map((r) => {
              const sel = r.sampleIndex != null && r.sampleIndex === selectedSample;
              return (
                <div
                  key={r.id}
                  role="row"
                  aria-selected={sel}
                  tabIndex={0}
                  className={`${card.trow} ${styles.row} ${sel ? styles.selected : ''}`}
                  style={grid}
                  onClick={() => onSelectRow(r)}
                  onKeyDown={onRowKey(r)}
                >
                  <div role="gridcell" className={`${styles.cell} ${styles.name}`}>{r.sample}</div>
                  <div role="gridcell" className={`${styles.cell} ${r.depth.missing ? card.missing : card.mono}`}>
                    {r.depth.missing ? t(r.depth.text) : r.depth.text}
                  </div>
                  {shown.map((k) => {
                    if (k === TYPE) return <div key={k} role="gridcell" className={styles.cell}>{r.typeCode}</div>;
                    if (k === LAYER) return <div key={k} role="gridcell" className={`${styles.cell} ${card.mono}`}>{layerText(r.layer)}</div>;
                    const c = r.cells[k];
                    return (
                      <div key={k} role="gridcell" className={styles.cell}>
                        {c ? (
                          <ValueCell certainty={c.mark?.certainty ?? null} onOpen={c.mark?.key ? () => onOpenSource(c.mark!.key!) : undefined}>
                            <span className={card.mono}>{c.text}</span>
                          </ValueCell>
                        ) : (
                          <span className={card.mono}>–</span>
                        )}
                      </div>
                    );
                  })}
                  <div role="gridcell" />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {rows.length === 0 && <div className={card.empty}>{t('No test results in source')}</div>}
    </section>
  );
}
