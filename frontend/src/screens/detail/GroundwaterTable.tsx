import { CertaintyMark } from '../../components/CertaintyMark';
import { SourceIcon } from '../../components/SourceIcon';
import type { Borehole } from '../../domain/types';
import { groundwaterRows } from './detailModel';
import card from './cards.module.css';
import styles from './GroundwaterTable.module.css';
import { useT } from '../../i18n';

interface Props {
  borehole: Borehole;
  onOpenSource(key: string): void;
}

/** GROUNDWATER table: one row per reading (type, depth, raw as printed, method, source). */
export function GroundwaterTable({ borehole: b, onOpenSource }: Props) {
  const rows = groundwaterRows(b);
  const t = useT();
  return (
    <section className={card.card} aria-label="Groundwater">
      <div className={card.head}>{t('GROUNDWATER')}</div>
      {rows.map((g) => (
        <div key={g.key} className={`${card.trow} ${styles.cols}`}>
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
