import { MethodBadge } from '../../components/MethodBadge';
import { SourceIcon } from '../../components/SourceIcon';
import type { Borehole } from '../../domain/types';
import { groundwaterRows } from './detailModel';
import card from './cards.module.css';
import styles from './GroundwaterTable.module.css';

interface Props {
  borehole: Borehole;
  onOpenSource(key: string): void;
}

/** GROUNDWATER table: one row per reading (type, depth, raw as printed, method, source). */
export function GroundwaterTable({ borehole: b, onOpenSource }: Props) {
  const rows = groundwaterRows(b);
  return (
    <section className={card.card} aria-label="Groundwater">
      <div className={card.head}>GROUNDWATER</div>
      {rows.map((g) => (
        <div key={g.key} className={`${card.trow} ${styles.cols}`}>
          <div className={styles.type}>{g.type}</div>
          <div className={`${styles.cell} ${card.mono} ${g.depth.missing ? card.missing : ''}`}>{g.depth.text}</div>
          <div className={`${styles.cell} ${styles.raw}`}>{g.raw}</div>
          <div>{g.method && <MethodBadge method={g.method} confidence={g.confidence} />}</div>
          <div>
            <SourceIcon onClick={() => onOpenSource(g.key)} />
          </div>
        </div>
      ))}
      {rows.length === 0 && <div className={card.empty}>No groundwater reading in source</div>}
    </section>
  );
}
