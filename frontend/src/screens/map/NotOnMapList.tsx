import { useEffect, useRef } from 'react';
import type { NotOnMapItem, OutsideSummary } from './mapModel';
import styles from './NotOnMapList.module.css';

interface Props {
  /** Boreholes without usable coordinates (in every focus). */
  items: NotOnMapItem[];
  /** The boreholes outside the focus country, as one line, or null (World, or none outside). */
  outside: OutsideSummary | null;
  /** "World" or the focus country's name. */
  focusLabel: string;
  /** The item a search just pointed to: highlighted and scrolled into view. */
  activeUid?: string | null;
  onOpen(uid: string): void;
  onShowWorld(): void;
}

function intro(items: number, outside: boolean, focusLabel: string): string {
  if (!items && !outside) return 'Every borehole has usable coordinates and is placed on the map.';
  if (items && outside) return `No usable coordinates, or outside ${focusLabel}, so these are listed instead of placed on the map.`;
  if (items) return 'No usable coordinates, so these are listed instead of placed on the map.';
  return `Outside ${focusLabel}, so these are listed instead of placed on the map.`;
}

/**
 * NOT ON MAP aside: boreholes without usable coordinates are listed, not plotted. A plausible wrong
 * pin is worse than no pin. Each item opens the borehole's detail. In a country view, the boreholes
 * in other countries are one summary line with SHOW WORLD. A search for one of the listed boreholes
 * highlights it.
 */
export function NotOnMapList({ items, outside, focusLabel, activeUid = null, onOpen, onShowWorld }: Props) {
  const count = items.length + (outside?.count ?? 0);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (activeUid) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeUid]);
  return (
    <aside className={styles.aside} aria-labelledby="not-on-map-title">
      <h2 id="not-on-map-title" className={styles.title}>
        NOT ON MAP ({count})
      </h2>
      <p className={styles.intro}>{intro(items.length, !!outside, focusLabel)}</p>
      {items.map(({ borehole: b, reason }) => (
        <button
          key={b.uid}
          ref={b.uid === activeUid ? activeRef : undefined}
          type="button"
          className={`${styles.item} ${b.uid === activeUid ? styles.itemActive : ''}`}
          data-uid={b.uid}
          aria-label={`Open detail of ${b.id}: ${reason.text}`}
          onClick={() => onOpen(b.uid)}
        >
          <span className={styles.id}>{b.id}</span>
          <span className={styles.project}>{b.project}</span>
          <span className={`${styles.reason} ${reason.warn ? styles.warn : ''}`}>{reason.text}</span>
        </button>
      ))}
      {outside && (
        <div className={styles.outside} data-testid="outside-focus">
          <span className={styles.outsideText}>{outside.text}</span>
          <span className={styles.project}>{outside.detail}</span>
          <button type="button" className={styles.showWorld} onClick={onShowWorld}>
            SHOW WORLD ›
          </button>
        </div>
      )}
    </aside>
  );
}
