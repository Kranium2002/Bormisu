import { useEffect } from 'react';
import { useAppStore } from '../../store/appStore';
import { PAGE_TYPE_LEGEND, PAGE_TYPE_META } from '../../theme';
import { DocumentCard } from './DocumentCard';
import { DropZone } from './DropZone';
import styles from './QueueScreen.module.css';

/** Page-type colour key for the page strips (log, lab table, text, drawing, photo). */
function PageTypeLegend() {
  return (
    <ul className={styles.legend} aria-label="Page types">
      {PAGE_TYPE_LEGEND.map((t) => {
        const m = PAGE_TYPE_META[t];
        return (
          <li key={t} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: m.color, borderColor: m.border }} aria-hidden="true" />
            {m.name}
          </li>
        );
      })}
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

/** Upload & queue: drop zone plus one card per document with status, checks, counts and page map. */
export function QueueScreen() {
  const documents = useAppStore((s) => s.documents);
  useRefuseStrayDrops();

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
            documents.map((d) => <DocumentCard key={d.id} doc={d} />)
          ) : (
            <div className={styles.empty}>No documents yet. Drop a report above to extract its boreholes.</div>
          )}
        </section>
      </div>
    </div>
  );
}
