import styles from './MapLegend.module.css';
import type { LegendEntry } from './mapModel';

/** REVIEW STATUS legend over the bottom-left of the map: the three pin colours with counts. */
export function MapLegend({ entries }: { entries: LegendEntry[] }) {
  return (
    <div className={styles.legend} role="group" aria-label="Review status legend">
      <div className={styles.title}>REVIEW STATUS</div>
      <ul className={styles.list}>
        {entries.map((e) => (
          <li key={e.status} className={styles.row} data-status={e.status}>
            <span className={styles.dot} style={{ background: e.color }} aria-hidden="true" />
            <span className={styles.label}>{e.label}</span>
            <span className={styles.count}>{e.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
