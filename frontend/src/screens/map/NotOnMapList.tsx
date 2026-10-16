import type { NotOnMapItem } from './mapModel';
import styles from './NotOnMapList.module.css';

interface Props {
  items: NotOnMapItem[];
  /** Name of the map focus region when some items lie outside it (mentioned in the intro), else null. */
  outsideRegion: string | null;
  onOpen(uid: string): void;
}

/**
 * NOT ON MAP aside: boreholes without usable coordinates, or outside the map focus, are listed, not
 * plotted. A plausible wrong pin is worse than no pin. Each item opens the borehole's detail.
 */
export function NotOnMapList({ items, outsideRegion, onOpen }: Props) {
  return (
    <aside className={styles.aside} aria-labelledby="not-on-map-title">
      <h2 id="not-on-map-title" className={styles.title}>
        NOT ON MAP ({items.length})
      </h2>
      <p className={styles.intro}>
        {!items.length
          ? 'Every borehole has usable coordinates and is placed on the map.'
          : outsideRegion
            ? `No usable coordinates, or outside ${outsideRegion}, so these are listed instead of placed on the map.`
            : 'No usable coordinates, so these are listed instead of placed on the map.'}
      </p>
      {items.map(({ borehole: b, reason }) => (
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
      ))}
    </aside>
  );
}
