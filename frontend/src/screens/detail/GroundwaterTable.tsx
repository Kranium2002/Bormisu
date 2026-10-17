import { CertaintyMark } from '../../components/CertaintyMark';
import { SourceIcon } from '../../components/SourceIcon';
import type { Borehole } from '../../domain/types';
import { groundwaterRows } from './detailModel';
import card from './cards.module.css';
import styles from './GroundwaterTable.module.css';
import { useT } from '../../i18n';

interface Props {
  borehole: Borehole;
  /** Key of the picked reading, highlighted here and as its triangle in the profile. */
  selected: string | null;
  onSelect(key: string): void;
  onOpenSource(key: string): void;
}

/** GROUNDWATER table: one row per reading (type, depth, raw as printed, ✓ / ?, source). A click picks the reading. */
export function GroundwaterTable({ borehole: b, selected, onSelect, onOpenSource }: Props) {
  const rows = groundwaterRows(b);
  const t = useT();
  return (
    <section className={card.card} aria-label="Groundwater">
      <div className={card.head}>{t('GROUNDWATER')}</div>
      {rows.map((g) => (
        <div key={g.key} role="button" tabIndex={0} aria-pressed={g.key === selected}
          className={`${card.trow} ${styles.cols} ${styles.row} ${g.key === selected ? styles.selected : ''}`}
          onClick={() => onSelect(g.key)}
          onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(g.key))}>
          <div className={styles.type}>{g.type}</div>
          <div className={`${styles.cell} ${g.depth.missing ? card.missing : card.mono}`}>{g.depth.text}</div>
          <div className={`${styles.cell} ${styles.raw}`}>{g.raw}</div>
          <div>{g.certainty && <CertaintyMark certainty={g.certainty} />}</div>
          <div>
            <SourceIcon
              dim={g.source.dim}
              title={g.source.title}
              onClick={g.source.clickable ? () => onOpenSource(g.key) : undefined}
            />
          </div>
        </div>
      ))}
      {rows.length === 0 && <div className={card.empty}>No groundwater reading in source</div>}
    </section>
  );
}
