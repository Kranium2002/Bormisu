import type { KeyboardEvent, MouseEvent } from 'react';
import { CertaintyMark } from '../../components/CertaintyMark';
import { SourceIcon } from '../../components/SourceIcon';
import type { Borehole } from '../../domain/types';
import { layerRows, type SptCell } from './detailModel';
import card from './cards.module.css';
import styles from './LayersTable.module.css';
import { useT } from '../../i18n';

interface Props {
  borehole: Borehole;
  selectedLayer: number;
  onSelectLayer(n: number): void;
  onOpenSource(key: string): void;
}

const HEADERS = ['#', 'FROM–TO (m)', 'LITHOLOGY', 'DIN', 'SPT', 'TCR (%)', 'RQD (%)', 'METHOD', ''];

/** SPT cell: R badge for a refusal plus the text; both open the source when there is one. */
function Spt({ spt, onOpen }: { spt: SptCell; onOpen: (e: MouseEvent) => void }) {
  const textClass = `${styles.sptText} ${spt.missing ? card.missing : card.mono} ${spt.lint ? styles.lintText : ''}`;
  if (!spt.source.clickable) {
    return (
      <>
        {spt.refusal && <span className={`${styles.rBadge} ${styles.inert}`} title={spt.title}>R</span>}
        <span className={textClass} title={spt.title}>{spt.text}</span>
      </>
    );
  }
  return (
    <>
      {spt.refusal && (
        <button type="button" className={styles.rBadge} title={spt.title} onClick={onOpen}>
          R
        </button>
      )}
      <button type="button" className={textClass} title={spt.title} onClick={onOpen}>
        {spt.text}
      </button>
    </>
  );
}

/** LAYERS table: row click selects the layer (in sync with the profile); SPT and icon open the source. */
export function LayersTable({ borehole: b, selectedLayer, onSelectLayer, onOpenSource }: Props) {
  const rows = layerRows(b);
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

  const t = useT();
  return (
    <section className={card.card} aria-label="Layers">
      <div className={card.head}>{t('LAYERS')}</div>
      <div role="table" aria-label="Layers">
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
              // A table row has no aria-selected: the selected layer is the current one.
              aria-current={sel ? 'true' : undefined}
              tabIndex={0}
              className={`${card.trow} ${styles.cols} ${styles.row} ${sel ? styles.selected : ''}`}
              onClick={() => onSelectLayer(r.n)}
              onKeyDown={onRowKey(r.n)}
            >
              <div role="cell" className={styles.cell}>{r.n}</div>
              <div role="cell" className={`${styles.cell} ${card.mono}`}>{r.range}</div>
              <div role="cell" className={`${styles.cell} ${r.lithology.missing ? card.missing : ''}`} title={r.printed}>
                {r.lithology.text}
              </div>
              <div role="cell" className={`${styles.cell} ${card.mono}`}>{r.din}</div>
              <div role="cell" className={`${styles.cell} ${styles.spt}`}>
                {r.spt ? <Spt spt={r.spt} onOpen={openFrom(r.spt.key)} /> : '–'}
              </div>
              <div role="cell" className={`${styles.cell} ${card.mono}`}>{r.tcr}</div>
              <div role="cell" className={`${styles.cell} ${card.mono}`}>{r.rqd}</div>
              <div role="cell" className={styles.cell}>
                <CertaintyMark certainty={r.certainty} />
              </div>
              <div role="cell">
                <SourceIcon
                  dim={r.source.dim}
                  title={r.source.title}
                  onClick={r.source.clickable && src ? () => onOpenSource(src) : undefined}
                />
              </div>
            </div>
          );
        })}
      </div>
      {rows.length === 0 && <div className={card.empty}>No layers in source</div>}
    </section>
  );
}
