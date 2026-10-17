import { useState, type ChangeEvent, type DragEvent } from 'react';
import { useAppStore } from '../../store/appStore';
import { acceptAttribute, uploadBlockedReason, uploadHint } from '../../store/uploads';
import styles from './DropZone.module.css';

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');

/**
 * Drop zone. Accepted types and the size limit come from the server's health answer (the file
 * chooser filters by them; drops are checked by the store, which explains refused files in red).
 * In demo mode (no provider keys) it is disabled with that reason.
 */
export function DropZone() {
  const dragActive = useAppStore((s) => s.dragActive);
  const dropError = useAppStore((s) => s.dropError);
  const addFiles = useAppStore((s) => s.addFiles);
  const setDragActive = useAppStore((s) => s.setDragActive);
  const health = useAppStore((s) => s.health);
  const blocked = uploadBlockedReason(health);
  const limits = health?.upload ?? null;
  /** Uploads still being sent (API mode posts each file before it shows up in the queue). */
  const [sending, setSending] = useState(0);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setSending((n) => n + 1);
    try {
      await addFiles(files);
    } finally {
      setSending((n) => n - 1);
    }
  };

  const onDragOver = (e: DragEvent<HTMLLabelElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = blocked ? 'none' : 'copy';
    if (!blocked) setDragActive(true);
  };

  const onDragLeave = (e: DragEvent<HTMLLabelElement>) => {
    // dragleave also fires when the pointer moves onto a child element; only a real exit counts.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragActive(false);
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (blocked) return;
    void upload(Array.from(e.dataTransfer.files));
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset so choosing the same file again fires another change.
    e.target.value = '';
    void upload(files);
  };

  return (
    <label
      className={`${styles.zone} ${dragActive ? styles.drag : ''} ${blocked ? styles.disabled : ''}`}
      aria-disabled={blocked ? true : undefined}
      title={blocked ?? undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        type="file"
        multiple
        accept={acceptAttribute(limits)}
        disabled={!!blocked}
        className={styles.input}
        onChange={onChange}
      />
      <span className={styles.title}>DROP REPORTS HERE</span>
      <span className={styles.sub}>{blocked ? `Uploading is off: ${blocked}.` : uploadHint(limits)}</span>
      {sending > 0 && (
        <span className={styles.uploading} role="status">
          Uploading…
        </span>
      )}
      {dropError && (
        <span className={styles.error} role="alert">
          {dropError}
        </span>
      )}
    </label>
  );
}
