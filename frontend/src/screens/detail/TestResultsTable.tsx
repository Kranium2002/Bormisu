import { useState, type ReactNode } from 'react';
import { AddColumnMenu, RemovableHeader, useColumns } from '../../components/ColumnChooser';
import { formatTestValue, TEST_FIELDS } from '../../domain/testResults';
import type { Borehole, Layer, TestResult } from '../../domain/types';
import { useT } from '../../i18n';
import card from './cards.module.css';
import styles from './TestResultsTable.module.css';

interface Props {
  borehole: Borehole;
  /** Selects the layer a sample lies in, so the profile and LAYERS show it too. */
  onSelectLayer(n: number): void;
}

/** A test-result column the user can add or remove (README_data `test_results`); SAMPLE and DEPTH always stay. */
interface TestColumn { key: string; label: string; group: string; min: number; cell(t: TestResult, layer: Layer | undefined): ReactNode }

const TEST_COLUMNS: readonly TestColumn[] = [
  { key: 'sample_type', label: 'TYPE', group: 'Sample', min: 70, cell: (r) => r.sampleType ?? '–' },
  { key: 'layer', label: 'LAYER', group: 'Sample', min: 90, cell: (_r, l) => (l ? `${l.n} · ${l.din || '–'}` : '–') },
  ...TEST_FIELDS.map((f): TestColumn => ({
    key: f.key, label: f.label.toUpperCase(), group: 'Lab tests', min: Math.max(90, f.label.length * 8 + 24),
    cell: (r) => {
      const v = r.values.find((x) => x.key === f.key);
      return <span className={card.mono}>{v ? formatTestValue(v) : '–'}</span>;
    },
  })),
];
const columnByKey = new Map(TEST_COLUMNS.map((c) => [c.key, c]));
const DEFAULT_TEST_COLUMNS = ['layer', 'water_content_pct', 'density_kn_m3', 'ucs_mpa', 'plasticity_index_pct'];
/** Narrowest widths (px) of the columns that always stay: SAMPLE, DEPTH, +. */
const FIXED = { sample: 110, depth: 90, add: 34 };

/**
 * TEST RESULTS table: one row per sample / test depth (API test_results[]). SAMPLE and DEPTH always stay;
 * the layer, the sample type and every lab value of README_data `test_results` come and go with + and ×.
 * A click on a row highlights it (like a layer row) and selects its layer.
 */
export function TestResultsTable({ borehole: b, onSelectLayer }: Props) {
  const t = useT();
  // The selected sample, per borehole (a new borehole starts without one).
  const [selected, setSelected] = useState<{ uid: string; i: number } | null>(null);
  const [keys, setKeys] = useColumns('bormisu.testColumns', DEFAULT_TEST_COLUMNS, (k) => columnByKey.has(k));
  const shown = keys.map((k) => columnByKey.get(k)!);
  const hidden = TEST_COLUMNS.filter((c) => !keys.includes(c.key));
  const grid = {
    gridTemplateColumns: [`${FIXED.sample}px`, `${FIXED.depth}px`, ...shown.map((c) => `minmax(${c.min}px, 1fr)`), `${FIXED.add}px`].join(' '),
  };
  const minWidth = FIXED.sample + FIXED.depth + FIXED.add + shown.reduce((a, c) => a + c.min, 0);
  const tests = [...(b.testResults ?? [])].sort((x, y) => (x.depth ?? Infinity) - (y.depth ?? Infinity));
  const layerAt = (d: number | null) => (d == null ? undefined : b.layers.find((l) => d >= l.from && d <= l.to));

  return (
    <section className={card.card} aria-label="Test results">
      <div className={card.head}>{t('TEST RESULTS')}</div>
      {tests.length > 0 && (
        <div className={styles.scroll}>
          <div role="table" aria-label="Test results" style={{ minWidth }}>
            <div role="row" className={card.thead} style={grid}>
              <div role="columnheader" className={card.th}>{t('SAMPLE')}</div>
              <div role="columnheader" className={card.th}>{t('DEPTH (m)')}</div>
              {shown.map((c) => (
                <RemovableHeader key={c.key} className={card.th} label={c.label} title={`test_results.${c.key}`}
                  onRemove={() => setKeys(keys.filter((k) => k !== c.key))} />
              ))}
              <div role="columnheader" className={`${card.th} ${styles.addCell}`} aria-label={t('Add a column')}>
                <AddColumnMenu hidden={hidden.map((c) => ({ key: c.key, label: c.label, group: c.group }))}
                  onAdd={(k) => setKeys([...keys, k])} />
              </div>
            </div>
            {tests.map((r, i) => {
              const layer = layerAt(r.depth);
              const sel = selected?.uid === b.uid && selected.i === i;
              const select = () => {
                setSelected({ uid: b.uid, i });
                if (layer) onSelectLayer(layer.n);
              };
              return (
                <div key={i} role="row" tabIndex={0} aria-current={sel ? 'true' : undefined}
                  className={`${card.trow} ${styles.row} ${sel ? styles.selected : ''}`} style={grid}
                  onClick={select}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select())}>
                  <div role="cell" className={`${styles.cell} ${styles.name}`}>{r.sampleName ?? '–'}</div>
                  <div role="cell" className={`${styles.cell} ${r.depth == null ? card.missing : card.mono}`}>
                    {r.depth == null ? 'not stated' : r.depth.toFixed(2)}
                  </div>
                  {shown.map((c) => (
                    <div key={c.key} role="cell" className={styles.cell}>{c.cell(r, layer)}</div>
                  ))}
                  <div role="cell" />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {tests.length === 0 && <div className={card.empty}>{t('No test results in source')}</div>}
    </section>
  );
}
