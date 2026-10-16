import type { KeyboardEvent, MouseEvent } from 'react';
import { MethodBadge } from '../../components/MethodBadge';
import { SourceIcon } from '../../components/SourceIcon';
import type { Borehole } from '../../domain/types';
import { layerLint, layerRows } from './detailModel';
import card from './cards.module.css';
import styles from './LayersTable.module.css';

interface Props {
  borehole: Borehole;
  selectedLayer: number;
  onSelectLayer(n: number): void;
  onOpenSource(key: string): void;
}

const HEADERS = ['#', 'FROM–TO M', 'LITHOLOGY', 'DIN', 'SPT', 'TCR %', 'RQD %', 'METHOD', ''];

/** LAYERS table: row click selects the layer (in sync with the profile); SPT and icon open the source. */
export function LayersTable({ borehole: b, selectedLayer, onSelectLayer, onOpenSource }: Props) {
  const rows = layerRows(b);
  const lint = layerLint(b);
  const openFrom = (key: string) => (e: MouseEvent) => {
    e.stopPropagation();
    onOpenSource(key);
  };
  const onRowKey = (n: number) => (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectLayer(n);
    }
  };

  return (
    <section className={card.card} aria-label="Layers">
      <div className={card.head}>LAYERS</div>
      <div role="grid" aria-label="Layers">
        <div role="row" className={`${card.thead} ${styles.cols}`}>
          {HEADERS.map((h, i) => (
            <div key={i} role="columnheader" className={card.th}>{h}</div>
          ))}
        </div>
        {rows.map((r) => {
          const sel = r.n === selectedLayer;
          const src = r.sourceKey;
          return (
            <div
              key={r.n}
              role="row"
              aria-selected={sel}
              tabIndex={0}
              className={`${card.trow} ${styles.cols} ${styles.row} ${sel ? styles.selected : ''}`}
              onClick={() => onSelectLayer(r.n)}
              onKeyDown={onRowKey(r.n)}
            >
              <div role="gridcell" className={styles.cell}>{r.n}</div>
              <div role="gridcell" className={`${styles.cell} ${card.mono}`}>{r.range}</div>
              <div role="gridcell" className={`${styles.cell} ${r.lithology.missing ? card.missing : ''}`} title={r.printed}>
                {r.lithology.text}
              </div>
              <div role="gridcell" className={`${styles.cell} ${card.mono}`}>{r.din}</div>
              <div role="gridcell" className={`${styles.cell} ${styles.spt}`}>
                {r.spt ? (
                  <>
                    {r.spt.refusal && (
                      <button type="button" className={styles.rBadge} title={r.spt.title} onClick={openFrom(r.spt.key)}>
                        R
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${styles.sptText} ${card.mono} ${r.spt.lint ? styles.lintText : ''}`}
                      title={r.spt.title}
                      onClick={openFrom(r.spt.key)}
                    >
                      {r.spt.text}
                    </button>
                  </>
                ) : (
                  '–'
                )}
              </div>
              <div role="gridcell" className={`${styles.cell} ${card.mono}`}>{r.tcr}</div>
              <div role="gridcell" className={`${styles.cell} ${card.mono}`}>{r.rqd}</div>
              <div role="gridcell" className={styles.cell}>
                <MethodBadge method={r.method} confidence={r.confidence} />
              </div>
              <div role="gridcell">
                {src && <SourceIcon onClick={() => onOpenSource(src)} />}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <div className={card.empty}>No layers in source</div>}
      </div>
      {lint && <div className={`${styles.lint} ${lint.severity === 'warning' ? styles.lintWarn : ''}`}>{lint.text}</div>}
    </section>
  );
}
