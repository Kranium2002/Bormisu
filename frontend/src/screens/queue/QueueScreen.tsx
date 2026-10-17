import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { retryBlockedReason } from '../../store/uploads';
import { PAGE_LEGEND } from '../../theme';
import { DocumentCard } from './DocumentCard';
import { DropZone } from './DropZone';
import styles from './QueueScreen.module.css';

/** How long a card stays highlighted after a "Same file as …" link pointed at it. */
const HIGHLIGHT_MS = 2000;

/**
 * Page-type colour key for the page strips: log, lab table, text, drawing, photo, a classified page
 * without a type, and a page not classified yet.
 */
function PageTypeLegend() {
  return (
    <ul className={styles.legend} aria-label="Page types">
      {PAGE_LEGEND.map((m) => (
        <li key={m.name} className={styles.legendItem}>
          <span className={styles.swatch} style={{ background: m.color, borderColor: m.border }} aria-hidden="true" />
          {m.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * Files dropped next to the drop zone would make the browser open them and leave the app.
 * While the queue is shown, such drops are refused; the drop zone handles its own events first.
 */
function useRefuseStrayDrops() {
  useEffect(() => {
    const refuse = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
    };
  }, []);
}

/** Upload & queue: drop zone plus one card per document with status, progress, checks, counts and page map. */
export function QueueScreen() {
  const documents = useAppStore((s) => s.documents);
  // RETRY needs a working extraction: off in demo mode, with the reason.
  const retryBlocked = useAppStore((s) => retryBlockedReason(s.health));
  const [highlight, setHighlight] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useRefuseStrayDrops();

  useEffect(() => () => clearTimeout(timer.current), []);

  /** Scrolls to a document's card and highlights it for a moment. */
  const showDocument = useCallback((id: string) => {
    document.querySelector(`[data-doc-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlight(id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  }, []);

  return (
    <div className={styles.scroll} data-screen-label="Upload & queue">
      <div className={styles.page}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>UPLOAD &amp; QUEUE</h1>
          <PageTypeLegend />
        </div>
        <DropZone />
        <div className={styles.columns} aria-hidden="true">
          <div>DOCUMENT</div>
          <div>STATUS</div>
          <div>CHECKS</div>
        </div>
        <section className={styles.list} aria-label="Document queue">
          {documents.length ? (
            documents.map((d) => (
              <DocumentCard
                key={d.id}
                doc={d}
                highlighted={highlight === d.id}
                retryBlocked={retryBlocked}
                onShowDocument={showDocument}
              />
            ))
          ) : (
            <div className={styles.empty}>No documents yet. Drop a report above to extract its boreholes.</div>
          )}
        </section>
      </div>
    </div>
  );
}
