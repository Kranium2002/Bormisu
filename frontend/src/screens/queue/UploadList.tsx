import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { EN, fill, type Tr } from '../review/fill';
import {
  formatBytes,
  isFinishedUpload,
  uploadBlockedReason,
  uploadPercent,
  uploadSummary,
  type UploadItem,
} from '../../store/uploads';
import { DROP_INPUT_ID } from './DropZone';
import styles from './UploadList.module.css';

/** The status text of one upload, e.g. "Uploading 45%", "Already uploaded", "Failed: …". */
export function uploadStatusText(item: UploadItem, t: Tr = EN): string {
  switch (item.status) {
    case 'queued':
      return t('Waiting');
    case 'uploading':
      return fill(t('Uploading {pct}%'), { pct: uploadPercent(item) });
    case 'done':
      return t(item.duplicate ? 'Already uploaded' : 'Uploaded');
    case 'failed':
      return `${t('Failed')}: ${item.error ?? t('unknown error')}`;
    case 'cancelled':
      return t('Cancelled');
  }
}

interface RowProps {
  item: UploadItem;
  /** Why RETRY is off (demo mode), or null. */
  retryBlocked: string | null;
  /** The item's document has a card in the queue (the SHOW DOCUMENT button points at it). */
  documentListed: boolean;
  onCancel(id: string): void;
  onRemove(id: string): void;
  onRetry(id: string): void;
  /** Scrolls to and highlights a document's card. */
  onShowDocument(documentId: string): void;
}

/**
 * One file of the upload queue: name, size and project, a progress bar of the bytes sent, the
 * status, and the actions that fit it (cancel while waiting or sending; show the document, retry or
 * remove once finished). A duplicate says "Already uploaded" and shows the existing document.
 */
export function UploadRow({ item, retryBlocked, documentListed, onCancel, onRemove, onRetry, onShowDocument }: RowProps) {
  const t = useT();
  const pct = uploadPercent(item);
  const status = uploadStatusText(item, t);
  const running = item.status === 'queued' || item.status === 'uploading';
  const showable = item.status === 'done' && item.documentId !== null && documentListed;
  const valueText = item.status === 'done' ? status : `${formatBytes(item.loaded)} of ${formatBytes(item.total)}`;

  return (
    <li className={`${styles.row} ${styles[item.status]}`} data-upload-id={item.id} aria-label={`${item.name}: ${status}`}>
      <div className={styles.ident}>
        <span className={styles.name} title={item.name}>
          {item.name}
        </span>
        <span className={styles.meta}>
          {formatBytes(item.size)}
          {item.project && ` · ${t('Project')}: ${item.project}`}
        </span>
      </div>
      <div className={styles.progress}>
        <div
          className={styles.bar}
          role="progressbar"
          aria-label={`Upload of ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={valueText}
        >
          <div className={styles.fill} style={{ width: `${pct}%` }} />
        </div>
        <span className={styles.status} role={item.status === 'failed' ? 'alert' : undefined}>
          {status}
        </span>
      </div>
      <div className={styles.actions}>
        {running && (
          <button type="button" className={styles.action} aria-label={`Cancel upload of ${item.name}`} onClick={() => onCancel(item.id)}>
            {t('CANCEL')}
          </button>
        )}
        {showable && (
          <button
            type="button"
            className={styles.action}
            aria-label={item.duplicate ? `Show the existing document of ${item.name}` : `Show the document of ${item.name}`}
            onClick={() => onShowDocument(item.documentId!)}
          >
            {t('SHOW DOCUMENT')}
          </button>
        )}
        {item.status === 'failed' && (
          <button
            type="button"
            className={styles.action}
            aria-label={`Retry upload of ${item.name}`}
            disabled={!!retryBlocked}
            title={retryBlocked ?? t('Send this file again')}
            aria-description={retryBlocked ?? undefined}
            onClick={() => onRetry(item.id)}
          >
            {t('RETRY')}
          </button>
        )}
        {isFinishedUpload(item) && (
          <button type="button" className={styles.remove} aria-label={`Remove ${item.name} from the list`} onClick={() => onRemove(item.id)}>
            {t('REMOVE')}
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The upload queue under the drop zone: one row per file, a summary that screen readers announce as
 * it changes, and CLEAR FINISHED. Focus stays in the list when a row's buttons change or a row goes.
 */
export function UploadList({ onShowDocument }: { onShowDocument(documentId: string): void }) {
  const t = useT();
  const uploads = useAppStore((s) => s.uploads);
  const documents = useAppStore((s) => s.documents);
  const retryBlocked = useAppStore((s) => uploadBlockedReason(s.health));
  const cancelUpload = useAppStore((s) => s.cancelUpload);
  const removeUpload = useAppStore((s) => s.removeUpload);
  const retryUpload = useAppStore((s) => s.retryUpload);
  const clearFinished = useAppStore((s) => s.clearFinishedUploads);
  const list = useRef<HTMLUListElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  /** Where focus goes after the list changed under it: a row (its first button) by index, or the heading. */
  const [refocus, setRefocus] = useState<{ index: number } | { heading: true } | null>(null);
  /** A row whose buttons are about to change (cancel, retry): its first button takes focus again. */
  const [keepFocus, setKeepFocus] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!refocus) return;
    setRefocus(null);
    const rows = list.current?.querySelectorAll<HTMLElement>('li[data-upload-id]');
    if (!rows?.length) {
      document.getElementById(DROP_INPUT_ID)?.focus();
      return;
    }
    if ('heading' in refocus) heading.current?.focus();
    else rows[Math.min(refocus.index, rows.length - 1)].querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [refocus]);

  useEffect(() => {
    if (!keepFocus) return;
    setKeepFocus(null);
    // The clicked button went away with the new status (CANCEL → REMOVE, RETRY → CANCEL): focus the row's first button.
    const row = list.current?.querySelector<HTMLElement>(`li[data-upload-id="${CSS.escape(keepFocus)}"]`);
    if (row && !row.contains(document.activeElement)) row.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [keepFocus]);

  if (!uploads.length) return null;
  const finished = uploads.filter(isFinishedUpload).length;
  const listed = new Set(documents.map((d) => d.id));

  const remove = (id: string) => {
    setRefocus({ index: uploads.findIndex((i) => i.id === id) });
    removeUpload(id);
  };

  return (
    <section className={styles.uploads} aria-labelledby="upload-list-title">
      <div className={styles.head}>
        <h2 id="upload-list-title" ref={heading} className={styles.title} tabIndex={-1}>
          {t('UPLOADS')}
        </h2>
        <span className={styles.summary} role="status" aria-live="polite">
          {uploadSummary(uploads)}
        </span>
        {finished > 0 && (
          <button
            type="button"
            className={styles.clear}
            onClick={() => {
              setRefocus({ heading: true });
              clearFinished();
            }}
          >
            {t('CLEAR FINISHED')}
          </button>
        )}
      </div>
      <ul ref={list} className={styles.list}>
        {uploads.map((item) => (
          <UploadRow
            key={item.id}
            item={item}
            retryBlocked={retryBlocked}
            documentListed={item.documentId !== null && listed.has(item.documentId)}
            onCancel={(id) => {
              setKeepFocus(id);
              cancelUpload(id);
            }}
            onRemove={remove}
            onRetry={(id) => {
              setKeepFocus(id);
              retryUpload(id);
            }}
            onShowDocument={onShowDocument}
          />
        ))}
      </ul>
    </section>
  );
}
