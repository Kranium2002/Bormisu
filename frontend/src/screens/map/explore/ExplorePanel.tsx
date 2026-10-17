/**
 * The left explore panel of the map screen (FRONTEND.md section 6, LGRB's accordion above its map):
 * PLACE SEARCH and FILTERS as collapsible sections whose open state each viewer keeps.
 *
 * - At 1280 px and wider it is a column left of the map.
 * - From 768 to 1279 px it is closed behind a SEARCH & FILTERS toggle and opens over the map.
 * - Below 768 px it opens as a full-screen sheet.
 * When it lies over the map (`overlay`), the focus moves into it on opening, Escape and CLOSE close it
 * and give the focus back to the toggle, and it gets out of the way once the map flies to a place or
 * a filter ran.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { AccordionSection, useSections } from './Accordion';
import styles from './ExplorePanel.module.css';
import { FilterPanel } from './FilterPanel';
import { PlaceSearch } from './PlaceSearch';

/** True while the panel lies over the map (narrower than 1280 px), see ExplorePanel.module.css. */
export function overlayLayout(): boolean {
  try {
    return globalThis.matchMedia?.('(max-width: 1279px)').matches ?? false;
  } catch {
    return false;
  }
}

interface Props {
  /** Open over the map (narrow screens); a wide screen always shows the panel. */
  open: boolean;
  /** Closes the overlay (CLOSE, Escape). */
  onClose(): void;
  /** The map flew to a place or a filter ran: an overlay gets out of the way. */
  onDone(): void;
}

export function ExplorePanel({ open, onClose, onDone }: Props) {
  const [sections, toggle] = useSections();
  const ref = useRef<HTMLDivElement>(null);

  // Opened over the map: the focus goes to its first section.
  useEffect(() => {
    if (open && overlayLayout()) ref.current?.querySelector<HTMLElement>('[aria-controls^="explore-"]')?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open || !overlayLayout()) return;
    // The panel closes first; the app's Escape (side panel, dialogs) waits for the next press.
    e.stopPropagation();
    onClose();
  };

  return (
    <div
      ref={ref}
      id="explore-panel"
      className={`${styles.panel} ${open ? styles.open : ''}`}
      role="region"
      aria-label="Search and filters"
      onKeyDown={onKeyDown}
    >
      <div className={styles.head}>
        <span className={styles.headTitle}>SEARCH &amp; FILTERS</span>
        <button type="button" className={styles.close} onClick={onClose}>
          CLOSE
        </button>
      </div>
      <AccordionSection id="place" title="PLACE SEARCH" open={sections.place} onToggle={toggle}>
        <PlaceSearch onFlown={onDone} />
      </AccordionSection>
      <AccordionSection id="filters" title="FILTERS" open={sections.filters} onToggle={toggle}>
        <FilterPanel onApplied={onDone} />
      </AccordionSection>
    </div>
  );
}
