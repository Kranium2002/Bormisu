import { useEffect, useRef, useState } from 'react';
import type { Borehole } from '../../domain/types';
import { useAppStore } from '../../store/appStore';
import { notOnMapReason } from './mapModel';
import styles from './NotOnMapList.module.css';

interface Props {
  /** The boreholes without a pin. */
  boreholes: Borehole[];
  /** All boreholes, plotted or not: 0 before anything is uploaded. */
  total: number;
  onOpen(uid: string): void;
}

/** How long the boreholes a queue card's WHY pointed at stay highlighted. */
const POINTED_MS = 4000;
/** The nonce of the last WHY request handled. */
let handledFocus: number | null = null;

/** Intro line of the aside: why these are listed, that all are placed, or that there are none yet. */
function introText(listed: number, total: number): string {
  if (total === 0) return 'No boreholes yet. Boreholes without usable coordinates are listed here once a report is uploaded.';
  if (listed) return 'No usable coordinates, so these are listed instead of placed on the map.';
  return 'Every borehole has usable coordinates and is placed on the map.';
}

/** Smooth scrolling unless the user asked for reduced motion (then it moves instantly). */
const scrollBehavior = (): ScrollBehavior =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/**
 * NOT ON MAP, under the map next to RESULTS (README acceptance: "listed under the map with their
 * reason, never placed at 0,0"): boreholes without usable coordinates are listed, not plotted, each
 * with the backend's reason as a label (UNPLOTTED_LABELS). A plausible wrong pin is worse than no
 * pin. Each item opens the borehole's detail. A queue card's "N not on the map · WHY"
 * (notOnMapFocus) scrolls the list into view, highlights that document's boreholes for a moment and
 * moves the focus to the first of them.
 */
export function NotOnMapList({ boreholes, total, onOpen }: Props) {
  const focus = useAppStore((s) => s.notOnMapFocus);
  const aside = useRef<HTMLElement>(null);
  const [pointed, setPointed] = useState<{ documentId: string | null; nonce: number } | null>(null);

  useEffect(() => {
    // Once per request, also across remounts (leaving the map and coming back points nowhere again).
    if (!focus || handledFocus === focus.nonce) return;
    handledFocus = focus.nonce;
    const root = aside.current;
    if (!root) return;
    root.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
    const first = focus.documentId
      ? root.querySelector<HTMLElement>(`[data-document-id="${CSS.escape(focus.documentId)}"]`)
      : root.querySelector<HTMLElement>('[data-uid]');
    (first ?? root.querySelector<HTMLElement>('h2'))?.focus({ preventScroll: true });
    setPointed(focus);
    const timer = setTimeout(() => setPointed((p) => (p?.nonce === focus.nonce ? null : p)), POINTED_MS);
    return () => clearTimeout(timer);
  }, [focus]);

  return (
    <aside ref={aside} className={styles.aside} aria-labelledby="not-on-map-title">
      <h2 id="not-on-map-title" className={styles.title} tabIndex={-1}>
        NOT ON MAP ({boreholes.length})
      </h2>
      <p className={styles.intro}>{introText(boreholes.length, total)}</p>
      {boreholes.map((b) => {
        const reason = notOnMapReason(b);
        const isPointed = !!pointed?.documentId && b.documentId === pointed.documentId;
        return (
          <button
            key={b.uid}
            type="button"
            className={`${styles.item} ${isPointed ? styles.pointed : ''}`}
            data-uid={b.uid}
            data-document-id={b.documentId ?? undefined}
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
