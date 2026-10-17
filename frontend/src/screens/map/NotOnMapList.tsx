import type { Borehole } from '../../domain/types';
import { notOnMapReason } from './mapModel';
import styles from './NotOnMapList.module.css';

interface Props {
  /** The boreholes without a pin. */
  boreholes: Borehole[];
  /** All boreholes, plotted or not: 0 before anything is uploaded. */
  total: number;
  onOpen(uid: string): void;
}

/** Intro line of the aside: why these are listed, that all are placed, or that there are none yet. */
function introText(listed: number, total: number): string {
  if (total === 0) return 'No boreholes yet. Boreholes without usable coordinates are listed here once a report is uploaded.';
  if (listed) return 'No usable coordinates, so these are listed instead of placed on the map.';
  return 'Every borehole has usable coordinates and is placed on the map.';
}

/**
 * NOT ON MAP aside: boreholes without usable coordinates are listed, not plotted.
 * A plausible wrong pin is worse than no pin. Each item opens the borehole's detail.
 */
export function NotOnMapList({ boreholes, total, onOpen }: Props) {
  return (
    <aside className={styles.aside} aria-labelledby="not-on-map-title">
      <h2 id="not-on-map-title" className={styles.title}>
        NOT ON MAP ({boreholes.length})
      </h2>
      <p className={styles.intro}>{introText(boreholes.length, total)}</p>
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
