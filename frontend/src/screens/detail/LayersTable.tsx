import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { AddColumnMenu, RemovableHeader, useColumns } from '../../components/ColumnChooser';
import { CertaintyMark } from '../../components/CertaintyMark';
import type { Borehole, Layer } from '../../domain/types';
import { useT } from '../../i18n';
import { layerLint, layerRows, type LayerRow, type SptCell, type ValueMark } from './detailModel';
import { ValueCell } from './ValueCell';
import card from './cards.module.css';
import styles from './LayersTable.module.css';

interface Props {
  borehole: Borehole;
  selectedLayer: number;
  onSelectLayer(n: number): void;
  onOpenSource(key: string): void;
}

/** `val` draws a value with its status dot; a click on it opens the document view at the value. */
type Val = (m: ValueMark | null, content: ReactNode) => ReactNode;

/** A layer column the user can add or remove; #, FROM–TO and LITHOLOGY always stay. */
interface LayerColumn {
  key: string;
  label: string;
  group: string;
  min: number;
  cell(r: LayerRow, l: Layer, openSpt: (e: MouseEvent) => void, val: Val): ReactNode;
}

const DASH = '–';
const mono = (v: ReactNode) => <span className={card.mono}>{v}</span>;
const LAYER_COLUMNS: readonly LayerColumn[] = [
  { key: 'din', label: 'DIN 4023', group: 'Layer', min: 84, cell: (r, _l, _o, val) => val(r.marks.lithology, mono(r.din)) },
  { key: 'strat', label: 'STRAT.', group: 'Layer', min: 100, cell: (r, _l, _o, val) => val(r.marks.strat, r.strat) },
  {
    key: 'spt', label: 'SPT', group: 'SPT', min: 120,
    cell: (r, _l, open) => (r.spt ? <Spt spt={r.spt} mark={r.marks.spt} onOpen={open} /> : DASH),
  },
  { key: 'tcr', label: 'TCR %', group: 'Core', min: 64, cell: (r, _l, _o, val) => val(r.marks.tcr, mono(r.tcr)) },
  { key: 'rqd', label: 'RQD %', group: 'Core', min: 64, cell: (r, _l, _o, val) => val(r.marks.rqd, mono(r.rqd)) },
  { key: 'printed', label: 'AS PRINTED', group: 'Layer', min: 180, cell: (_r, l) => l.lithologyAsPrinted || DASH },
  { key: 'consistency', label: 'CONSISTENCY', group: 'Properties', min: 110, cell: (r) => r.extra.consistency },
  { key: 'moisture', label: 'MOISTURE', group: 'Properties', min: 90, cell: (r) => r.extra.moisture },
  { key: 'weathering', label: 'WEATHERING', group: 'Properties', min: 100, cell: (r) => r.extra.weathering },
  { key: 'colour', label: 'COLOUR', group: 'Properties', min: 90, cell: (r) => r.extra.colour },
  { key: 'core', label: 'CORED', group: 'Core', min: 64, cell: (r) => r.extra.core },
  { key: 'soilUnit', label: 'SOIL UNIT', group: 'Layer', min: 100, cell: (r) => r.extra.soilUnit },
  { key: 'age', label: 'GEOLOGIC AGE', group: 'Layer', min: 110, cell: (r) => r.extra.age },
  { key: 'sptN', label: 'SPT N', group: 'SPT', min: 60, cell: (_r, l) => mono(l.spt?.n ?? DASH) },
  { key: 'sptIncrements', label: 'SPT INCREMENTS', group: 'SPT', min: 120, cell: (_r, l) => mono(l.spt?.increments?.join(', ') ?? DASH) },
  {
    key: 'sptDepth', label: 'SPT DEPTH (m)', group: 'SPT', min: 110,
    cell: (_r, l) => (l.spt ? (l.spt.depth == null ? <span className={card.missing}>not stated</span> : mono(l.spt.depth.toFixed(2))) : DASH),
  },
];
const columnByKey = new Map(LAYER_COLUMNS.map((c) => [c.key, c]));
const DEFAULT_LAYER_COLUMNS = ['din', 'strat', 'spt', 'tcr', 'rqd'];
/** Narrowest widths (px) of the columns that always stay: #, FROM–TO, LITHOLOGY … +. */
const FIXED = { n: 34, range: 124, lithology: 190, add: 34 };

/** SPT cell: dot, R badge for a refusal, and the text; R and text open the source. */
function Spt({ spt, mark, onOpen }: { spt: SptCell; mark: ValueMark | null; onOpen: (e: MouseEvent) => void }) {
  return (
    <span className={styles.spt}>
      {mark && <CertaintyMark certainty={mark.certainty} />}
      {spt.refusal && (
        <button type="button" className={styles.rBadge} title={spt.title} onClick={onOpen}>
          R
        </button>
      )}
      <button type="button" className={`${styles.sptText} ${card.mono} ${spt.lint ? styles.lintText : ''}`} title={spt.title} onClick={onOpen}>
        {spt.text}
      </button>
    </span>
  );
}

/**
 * LAYERS table: English lithology (the description as printed on hover), status dots in the cells, and
 * the optional columns (DIN 4023 notation, stratigraphy, SPT, TCR, RQD, properties …) that come and go
 * with × and +. Row click selects the layer (in sync with the profile); a value opens the document view.
 */
export function LayersTable({ borehole: b, selectedLayer, onSelectLayer, onOpenSource }: Props) {
  const t = useT();
  const rows = layerRows(b);
  const lint = layerLint(b);
  const [keys, setKeys] = useColumns('bormisu.detail.layerColumns', DEFAULT_LAYER_COLUMNS, (k) => columnByKey.has(k));
  const shown = keys.map((k) => columnByKey.get(k)!);
  const hidden = LAYER_COLUMNS.filter((c) => !keys.includes(c.key));
  const grid = {
    gridTemplateColumns: [`${FIXED.n}px`, `${FIXED.range}px`, `minmax(${FIXED.lithology}px, 2fr)`, ...shown.map((c) => `minmax(${c.min}px, 1fr)`), `${FIXED.add}px`].join(' '),
  };
  const minWidth = FIXED.n + FIXED.range + FIXED.lithology + FIXED.add + shown.reduce((a, c) => a + c.min, 0);
  const val: Val = (m, content) => (
    <ValueCell certainty={m?.certainty ?? null} onOpen={m?.key ? () => onOpenSource(m.key!) : undefined}>
      {content}
    </ValueCell>
  );
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
      <div className={card.head}>{t('LAYERS')}</div>
      <div className={styles.scroll}>
        <div role="grid" aria-label="Layers" style={{ minWidth }}>
          <div role="row" className={card.thead} style={grid}>
            {['#', 'FROM–TO M', 'LITHOLOGY'].map((h) => (
              <div key={h} role="columnheader" className={card.th}>{t(h)}</div>
            ))}
            {shown.map((c) => (
              <RemovableHeader key={c.key} className={card.th} label={c.label} onRemove={() => setKeys(keys.filter((k) => k !== c.key))} />
            ))}
            <div role="columnheader" className={`${card.th} ${styles.addCell}`} aria-label={t('Add a column')}>
              <AddColumnMenu hidden={hidden.map((c) => ({ key: c.key, label: c.label, group: c.group }))} onAdd={(k) => setKeys([...keys, k])} />
            </div>
          </div>
          {rows.map((r) => {
            const sel = r.n === selectedLayer;
            const layer = b.layers.find((l) => l.n === r.n)!;
            return (
              <div
                key={r.n}
                role="row"
                aria-selected={sel}
                tabIndex={0}
                className={`${card.trow} ${styles.row} ${sel ? styles.selected : ''}`}
                style={grid}
                onClick={() => onSelectLayer(r.n)}
                onKeyDown={onRowKey(r.n)}
              >
                <div role="gridcell" className={styles.cell}>{r.n}</div>
                <div role="gridcell" className={styles.cell}>{val(r.marks.range, mono(r.range))}</div>
                <div role="gridcell" className={`${styles.cell} ${r.lithology.missing ? card.missing : ''}`} title={r.printed}>
                  {val(r.marks.lithology, <span>{r.lithology.missing ? t(r.lithology.text) : r.lithology.text}</span>)}
                </div>
                {shown.map((c) => (
                  <div key={c.key} role="gridcell" className={styles.cell}>
                    {c.cell(r, layer, r.spt ? openFrom(r.spt.key) : () => undefined, val)}
                  </div>
                ))}
                <div role="gridcell" />
              </div>
            );
          })}
        </div>
      </div>
      {rows.length === 0 && <div className={card.empty}>{t('No layers in source')}</div>}
      {lint && <div className={`${styles.lint} ${lint.severity === 'warning' ? styles.lintWarn : ''}`}>{lint.text}</div>}
    </section>
  );
}
