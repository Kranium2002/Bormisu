/**
 * The map's FILTERS panel (frontend_din: the map stays full-bleed): PLACE SEARCH and FILTERS as
 * collapsible sections whose open state each viewer keeps, in a panel over the map's top-left corner
 * that the FILTERS button opens. Closed by default; below 768 px it is a full-screen sheet.
 *
 * It stays mounted while closed (hidden), so what was typed survives closing it. On opening the focus
 * moves into it; Escape and CLOSE close it and give the focus back to the FILTERS button. On a phone
 * it gets out of the way once the map flies to a place or a filter ran.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useT } from '../../../i18n';
import { AccordionSection, useSections } from './Accordion';
import styles from './ExplorePanel.module.css';
import { FilterPanel } from './FilterPanel';
import { PlaceSearch } from './PlaceSearch';

/** True while the panel is a full-screen sheet (narrower than 768 px), see ExplorePanel.module.css. */
export function sheetLayout(): boolean {
  try {
    return globalThis.matchMedia?.('(max-width: 767px)').matches ?? false;
  } catch {
    return false;
  }
}

/** @deprecated The panel always lies over the map now; kept for existing imports. */
export const overlayLayout = () => true;

interface Props {
  open: boolean;
  /** Closes the panel (CLOSE, Escape). */
  onClose(): void;
}

export function ExplorePanel({ open, onClose }: Props) {
  const t = useT();
  const [sections, toggle] = useSections();
  const ref = useRef<HTMLDivElement>(null);

  // Opened: the focus goes to its first section.
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('[aria-controls^="explore-"]')?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    // The panel closes first; the app's Escape (side panel, dialogs) waits for the next press.
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    onClose();
  };

  // A phone's sheet covers the map: it closes once the map flew somewhere or a filter ran.
  const done = () => {
    if (open && sheetLayout()) onClose();
  };

  return (
    <div
      ref={ref}
      id="explore-panel"
      className={styles.panel}
      role="region"
      aria-label="Search and filters"
      hidden={!open}
      onKeyDown={onKeyDown}
    >
      <div className={styles.head}>
        <span className={styles.headTitle}>{t('FILTERS')}</span>
        <button type="button" className={styles.close} onClick={onClose}>
          {t('CLOSE')}
        </button>
      </div>
      <AccordionSection id="place" title={t('PLACE SEARCH')} open={sections.place} onToggle={toggle}>
        <PlaceSearch onFlown={done} />
      </AccordionSection>
      <AccordionSection id="filters" title={t('FILTERS')} open={sections.filters} onToggle={toggle}>
        <FilterPanel onApplied={done} />
      </AccordionSection>
    </div>
  );
}
