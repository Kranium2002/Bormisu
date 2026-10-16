import type { Borehole } from '../../domain/types';
import { notOnMapReason } from './mapModel';
import styles from './NotOnMapList.module.css';

/**
 * NOT ON MAP aside: boreholes without usable coordinates are listed, not plotted.
 * A plausible wrong pin is worse than no pin. Each item opens the borehole's detail.
 */
export function NotOnMapList({ boreholes, onOpen }: { boreholes: Borehole[]; onOpen(uid: string): void }) {
  return (
    <aside className={styles.aside} aria-labelledby="not-on-map-title">
      <h2 id="not-on-map-title" className={styles.title}>
        NOT ON MAP ({boreholes.length})
      </h2>
      <p className={styles.intro}>
        {boreholes.length
          ? 'No usable coordinates, so these are listed instead of placed on the map.'
          : 'Every borehole has usable coordinates and is placed on the map.'}
      </p>
      {boreholes.map((b) => {
        const reason = notOnMapReason(b);
        return (
          <button
            key={b.uid}
            type="button"
            className={styles.item}
            data-uid={b.uid}
            aria-label={`Open detail of ${b.id}: ${reason.text}`}
            onClick={() => onOpen(b.uid)}
          >
            <span className={styles.id}>{b.id}</span>
            <span className={styles.project}>{b.project}</span>
            <span className={`${styles.reason} ${reason.warn ? styles.warn : ''}`}>{reason.text}</span>
          </button>
        );
      })}
    </aside>
  );
}
