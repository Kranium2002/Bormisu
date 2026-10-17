/**
 * Collapsible sections of the explore panel (LGRB's "Ortssuche" / "Filter" accordion). Each heading
 * holds a button with aria-expanded and aria-controls, so Tab, Enter and Space open and close it;
 * the closed body is `hidden`. Which sections are open is remembered per viewer in localStorage;
 * storage can be missing or blocked (private windows, tests), so every access is guarded and the
 * panel works without it.
 */
import { useState, type ReactNode } from 'react';
import styles from './Accordion.module.css';

export type SectionId = 'place' | 'filters';
export type SectionsOpen = Record<SectionId, boolean>;

export const SECTIONS_KEY = 'bormisu.explore.sections';
/** Both open at first: the place search and the filters are the panel's two jobs. */
export const DEFAULT_SECTIONS: SectionsOpen = { place: true, filters: true };

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored open state; the defaults for anything missing, unreadable or not a boolean. */
export function readSections(storage: ReadStorage | null = browserStorage()): SectionsOpen {
  try {
    const raw = storage?.getItem(SECTIONS_KEY);
    const stored: unknown = raw ? JSON.parse(raw) : null;
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_SECTIONS };
    const s = stored as Partial<Record<SectionId, unknown>>;
    return {
      place: typeof s.place === 'boolean' ? s.place : DEFAULT_SECTIONS.place,
      filters: typeof s.filters === 'boolean' ? s.filters : DEFAULT_SECTIONS.filters,
    };
  } catch {
    return { ...DEFAULT_SECTIONS };
  }
}

/** Stores the open state; a failure is ignored (the state still holds for this visit). */
export function writeSections(open: SectionsOpen, storage: WriteStorage | null = browserStorage()): void {
  try {
    storage?.setItem(SECTIONS_KEY, JSON.stringify(open));
  } catch {
    /* storage blocked or full */
  }
}

/** The open state of the sections, read once and written on every change. */
export function useSections(): [SectionsOpen, (id: SectionId) => void] {
  const [open, setOpen] = useState(readSections);
  const toggle = (id: SectionId) =>
    setOpen((current) => {
      const next = { ...current, [id]: !current[id] };
      writeSections(next);
      return next;
    });
  return [open, toggle];
}

interface SectionProps {
  id: SectionId;
  title: string;
  open: boolean;
  onToggle(id: SectionId): void;
  children: ReactNode;
}

/** One section: its heading button and its body. */
export function AccordionSection({ id, title, open, onToggle, children }: SectionProps) {
  const head = `explore-${id}-head`;
  const body = `explore-${id}-body`;
  return (
    <section className={styles.section} aria-labelledby={head}>
      <h2 className={styles.heading}>
        <button
          id={head}
          type="button"
          className={styles.trigger}
          aria-expanded={open}
          aria-controls={body}
          onClick={() => onToggle(id)}
        >
          {title}
        </button>
      </h2>
      <div id={body} className={styles.body} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
