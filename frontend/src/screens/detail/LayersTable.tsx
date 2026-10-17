import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { AddColumnMenu, RemovableHeader, useColumns } from '../../components/ColumnChooser';
import { CertaintyMark } from '../../components/CertaintyMark';
import { SourceIcon } from '../../components/SourceIcon';
import type { Borehole, Layer } from '../../domain/types';
import { layerRows, type LayerRow, type SptCell } from './detailModel';
import card from './cards.module.css';
import styles from './LayersTable.module.css';
import { useT } from '../../i18n';

interface Props {
  borehole: Borehole;
  selectedLayer: number;
  onSelectLayer(n: number): void;
  onOpenSource(key: string): void;
}

/** A layer column the user can add or remove (README_data `layers`); #, FROM–TO and LITHOLOGY always stay. */
interface LayerColumn { key: string; label: string; min: number; cell(r: LayerRow, l: Layer, openSpt: (e: MouseEvent) => void): ReactNode }

const yes = (v: boolean | undefined) => (v ? 'yes' : '–');
const txt = (v: unknown) => (v == null || v === '' ? '–' : String(v));
const mono = (v: ReactNode) => <span className={card.mono}>{v}</span>;
const LAYER_COLUMNS: readonly LayerColumn[] = [
  { key: 'din_code', label: 'DIN', min: 60, cell: (r) => mono(r.din) },
  { key: 'spt', label: 'SPT', min: 108, cell: (r, _l, open) => (r.spt ? <span className={styles.spt}><Spt spt={r.spt} onOpen={open} /></span> : '–') },
  { key: 'total_core_recovery', label: 'TCR (%)', min: 64, cell: (r) => mono(r.tcr) },
  { key: 'rqd', label: 'RQD (%)', min: 64, cell: (r) => mono(r.rqd) },
  { key: 'original_description', label: 'AS PRINTED', min: 180, cell: (_r, l) => txt(l.lithologyAsPrinted) },
  { key: 'uscs_group', label: 'USCS', min: 60, cell: (_r, l) => mono(txt(l.fields?.uscs_group)) },
  { key: 'strength', label: 'STRENGTH', min: 100, cell: (_r, l) => txt(l.props?.consistencyDensity) },
  { key: 'weathering', label: 'WEATHERING', min: 100, cell: (_r, l) => mono(txt(l.props?.weathering)) },
  { key: 'jointing', label: 'JOINTING', min: 110, cell: (_r, l) => txt(l.props?.jointing) },
  { key: 'wet', label: 'WET', min: 50, cell: (_r, l) => yes(l.props?.wet) },
  { key: 'stratigraphic_name', label: 'FORMATION', min: 150, cell: (_r, l) => txt(l.fields?.stratigraphic_name) },
  { key: 'geologic_age', label: 'GEOLOGIC AGE', min: 110, cell: (_r, l) => txt(l.fields?.geologic_age) },
  { key: 'core', label: 'CORE', min: 60, cell: (_r, l) => yes(l.props?.core) },
  { key: 'spt_n_value', label: 'SPT N', min: 60, cell: (_r, l) => mono(txt(l.spt?.n)) },
  { key: 'spt_refusal', label: 'SPT REFUSAL', min: 100, cell: (_r, l) => (l.spt ? (l.spt.refusal ? 'yes' : 'no') : '–') },
  { key: 'spt_increments', label: 'SPT INCREMENTS', min: 120, cell: (_r, l) => mono(l.spt?.increments?.join(', ') ?? '–') },
  { key: 'spt_penetration', label: 'SPT PENETRATION (cm)', min: 150, cell: (_r, l) => mono(txt(l.spt?.penetrationCm)) },
  { key: 'spt_depth', label: 'SPT DEPTH (m)', min: 110, cell: (_r, l) => mono(l.spt ? l.spt.depth.toFixed(2) : '–') },
];
const columnByKey = new Map(LAYER_COLUMNS.map((c) => [c.key, c]));
const DEFAULT_LAYER_COLUMNS = ['din_code', 'spt', 'total_core_recovery', 'rqd'];
/** Narrowest widths (px) of the columns that always stay: #, FROM–TO, LITHOLOGY … CHECK, source, +. */
const FIXED = { n: 34, range: 112, lithology: 180, check: 60, source: 30, add: 34 };

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

/**
 * LAYERS table: row click selects the layer (in sync with the profile); SPT and icon open the source.
 * #, FROM–TO and LITHOLOGY always stay; the other README_data layer columns come and go with + and ×.
 */
export function LayersTable({ borehole: b, selectedLayer, onSelectLayer, onOpenSource }: Props) {
  const rows = layerRows(b);
  const [keys, setKeys] = useColumns('bormisu.layerColumns', DEFAULT_LAYER_COLUMNS, (k) => columnByKey.has(k));
  const shown = keys.map((k) => columnByKey.get(k)!);
  const hidden = LAYER_COLUMNS.filter((c) => !keys.includes(c.key));
  const grid = {
    gridTemplateColumns: [`${FIXED.n}px`, `${FIXED.range}px`, `minmax(${FIXED.lithology}px, 2fr)`,
      ...shown.map((c) => `minmax(${c.min}px, 1fr)`), `${FIXED.check}px`, `${FIXED.source}px`, `${FIXED.add}px`].join(' '),
  };
  const minWidth = FIXED.n + FIXED.range + FIXED.lithology + FIXED.check + FIXED.source + FIXED.add + shown.reduce((a, c) => a + c.min, 0);
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
      <div className={styles.scroll}>
      <div role="table" aria-label="Layers" style={{ minWidth }}>
        <div role="row" className={card.thead} style={grid}>
          {['#', 'FROM–TO (m)', 'LITHOLOGY'].map((h) => (
            <div key={h} role="columnheader" className={card.th}>{t(h)}</div>
          ))}
          {shown.map((c) => (
            <RemovableHeader key={c.key} className={card.th} label={c.label} title={`layers.${c.key}`}
              onRemove={() => setKeys(keys.filter((k) => k !== c.key))} />
          ))}
          <div role="columnheader" className={card.th}>{t('CHECK')}</div>
          <div role="columnheader" className={card.th} aria-label="Source" />
          <div role="columnheader" className={`${card.th} ${styles.addCell}`} aria-label={t('Add a column')}>
            <AddColumnMenu hidden={hidden.map((c) => ({ key: c.key, label: c.label }))} onAdd={(k) => setKeys([...keys, k])} />
          </div>
        </div>
        {rows.map((r) => {
          const sel = r.n === selectedLayer;
          const src = r.sourceKey;
          const layer = b.layers.find((l) => l.n === r.n)!;
          return (
            <div
              key={r.n}
              role="row"
              // A table row has no aria-selected: the selected layer is the current one.
              aria-current={sel ? 'true' : undefined}
              tabIndex={0}
              className={`${card.trow} ${styles.row} ${sel ? styles.selected : ''}`}
              style={grid}
              onClick={() => onSelectLayer(r.n)}
              onKeyDown={onRowKey(r.n)}
            >
              <div role="cell" className={styles.cell}>{r.n}</div>
              <div role="cell" className={`${styles.cell} ${card.mono}`}>{r.range}</div>
              <div role="cell" className={`${styles.cell} ${r.lithology.missing ? card.missing : ''}`} title={r.printed}>
                {r.lithology.text}
              </div>
              {shown.map((c) => (
                <div key={c.key} role="cell" className={styles.cell}>
                  {c.cell(r, layer, r.spt ? openFrom(r.spt.key) : () => undefined)}
                </div>
              ))}
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
              <div role="cell" />
            </div>
          );
        })}
      </div>
      </div>
      {rows.length === 0 && <div className={card.empty}>No layers in source</div>}
    </section>
  );
}
