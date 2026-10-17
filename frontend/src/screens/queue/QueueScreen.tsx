import { useEffect } from 'react';
import { withInlineCode } from '../../components/EmptyState';
import { useAppStore } from '../../store/appStore';
import { DocumentCard } from './DocumentCard';
import { DropZone } from './DropZone';
import styles from './QueueScreen.module.css';

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

/**
 * Upload & queue: drop zone plus one card per document with status, and checks. When
 * the backend has boreholes but no document list (API mode), an amber notice says so above the queue.
 */
export function QueueScreen() {
  const documents = useAppStore((s) => s.documents);
  const documentsUnavailable = useAppStore((s) => s.documentsUnavailable);
  useRefuseStrayDrops();
  // Without a document list from the backend the notice says why the queue is empty; "No documents
  // yet" would contradict it. Documents uploaded in this session still show.
  const showQueue = documents.length > 0 || !documentsUnavailable;

  return (
    <div className={styles.scroll} data-screen-label="Upload & queue">
      <div className={styles.page}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>UPLOAD &amp; QUEUE</h1>
        </div>
        <DropZone />
        {documentsUnavailable && (
          <p className={styles.notice} role="status">
            {withInlineCode('The backend has no document list yet (GET /api/v1/documents). Boreholes still show on the map.')}
          </p>
        )}
        {showQueue && (
          <>
            <div className={styles.colHead} aria-hidden="true">
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
          </>
        )}
      </div>
    </div>
  );
}
