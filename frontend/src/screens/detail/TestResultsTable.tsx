import { useState } from 'react';
import { formatTestValue } from '../../domain/testResults';
import type { Borehole } from '../../domain/types';
import card from './cards.module.css';
import styles from './TestResultsTable.module.css';
import { useT } from '../../i18n';

interface Props {
  borehole: Borehole;
  /** Selects the layer a sample lies in, so the profile and LAYERS show it too. */
  onSelectLayer(n: number): void;
}

/**
 * TEST RESULTS table: one row per sample / test depth (API test_results[]): sample name and type, depth,
 * the layer that depth lies in, and every value measured on it. Values the source doesn't state are left out.
 * A click on a row highlights it (like a layer row) and selects its layer.
 */
export function TestResultsTable({ borehole: b, onSelectLayer }: Props) {
  const t = useT();
  // The selected sample, per borehole (a new borehole starts without one).
  const [selected, setSelected] = useState<{ uid: string; i: number } | null>(null);
  const tests = [...(b.testResults ?? [])].sort((x, y) => (x.depth ?? Infinity) - (y.depth ?? Infinity));
  const layerAt = (d: number | null) => (d == null ? undefined : b.layers.find((l) => d >= l.from && d <= l.to));
  return (
    <section className={card.card} aria-label="Test results">
      <div className={card.head}>{t('TEST RESULTS')}</div>
      {tests.length > 0 && (
        <div className={`${card.trow} ${styles.cols} ${styles.header}`}>
          <div className={styles.cell}>{t('SAMPLE')}</div>
          <div className={styles.cell}>{t('DEPTH (m)')}</div>
          <div className={styles.cell}>{t('LAYER')}</div>
          <div className={styles.cell}>{t('RESULTS')}</div>
        </div>
      )}
      {tests.map((r, i) => {
        const layer = layerAt(r.depth);
        const sel = selected?.uid === b.uid && selected.i === i;
        const select = () => {
          setSelected({ uid: b.uid, i });
          if (layer) onSelectLayer(layer.n);
        };
        return (
          <div key={i} role="button" tabIndex={0} aria-pressed={sel}
            className={`${card.trow} ${styles.cols} ${styles.row} ${sel ? styles.selected : ''}`}
            onClick={select}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select())}>
            <div className={styles.cell}>
              <span className={styles.name}>{r.sampleName ?? '–'}</span>
              {r.sampleType && <span className={styles.type}>{r.sampleType}</span>}
            </div>
            <div className={`${styles.cell} ${r.depth == null ? card.missing : card.mono}`}>
              {r.depth == null ? 'not stated' : r.depth.toFixed(2)}
            </div>
            <div className={`${styles.cell} ${layer ? '' : card.missing}`}>{layer ? `${layer.n} · ${layer.din || '–'}` : '–'}</div>
            <div className={`${styles.cell} ${styles.values}`}>
              {r.values.length === 0 && <span className={card.missing}>{t('no values in source')}</span>}
              {r.values.map((v) => (
                <span key={v.key} className={styles.value}>
                  {v.label} <span className={card.mono}>{formatTestValue(v)}</span>
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {tests.length === 0 && <div className={card.empty}>{t('No test results in source')}</div>}
    </section>
  );
}
