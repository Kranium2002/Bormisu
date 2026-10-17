import type { Ref } from 'react';
import styles from './MapLegend.module.css';
import type { LegendEntry } from './mapModel';

/**
 * REVIEW STATUS legend over the bottom-left of the map: the three pin colours with counts. The map
 * measures it (`ref`) to keep pins out from under it when it fits the pins.
 */
export function MapLegend({ entries, ref }: { entries: LegendEntry[]; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className={styles.legend} role="group" aria-label="Review status legend">
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
