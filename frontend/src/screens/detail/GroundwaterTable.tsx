import type { Borehole } from '../../domain/types';
import { useT } from '../../i18n';
import { groundwaterRows } from './detailModel';
import { ValueCell } from './ValueCell';
import card from './cards.module.css';
import styles from './GroundwaterTable.module.css';

interface Props {
  borehole: Borehole;
  onOpenSource(key: string): void;
}

/**
 * GROUNDWATER table: one row per reading (type, status dot + depth, raw as printed). A reading with a
 * provenance entry opens the document view at its value.
 */
export function GroundwaterTable({ borehole: b, onOpenSource }: Props) {
  const t = useT();
  const rows = groundwaterRows(b);
  return (
    <section className={card.card} aria-label="Groundwater">
      <div className={card.head}>{t('GROUNDWATER')}</div>
      {rows.map((g) => (
        <div key={g.key} className={`${card.trow} ${styles.cols}`}>
          <div className={styles.type}>{t(g.type)}</div>
          <div className={styles.cell}>
            <ValueCell certainty={g.certainty} onOpen={g.hasSource ? () => onOpenSource(g.key) : undefined}>
              <span className={g.depth.missing ? card.missing : card.mono}>{g.depth.missing ? t(g.depth.text) : g.depth.text}</span>
            </ValueCell>
          </div>
          <div className={`${styles.cell} ${styles.raw}`}>{g.raw}</div>
        </div>
      ))}
      {rows.length === 0 && <div className={card.empty}>{t('No groundwater reading in source')}</div>}
    </section>
  );
}
