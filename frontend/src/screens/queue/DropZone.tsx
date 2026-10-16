import { useState, type ChangeEvent, type DragEvent } from 'react';
import { useAppStore } from '../../store/appStore';
import styles from './DropZone.module.css';

/** File chooser filter. Drops are not filtered: the store rejects other types with a red error. */
const ACCEPT = '.pdf,.docx,.jpg,.jpeg,.png';

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');

/** Drop zone for PDF / DOCX / JPG / PNG. Click opens the file chooser; unsupported files show a red error. */
export function DropZone() {
  const dragActive = useAppStore((s) => s.dragActive);
  const dropError = useAppStore((s) => s.dropError);
  const addFiles = useAppStore((s) => s.addFiles);
  const setDragActive = useAppStore((s) => s.setDragActive);
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
    e.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  };

  const onDragLeave = (e: DragEvent<HTMLLabelElement>) => {
    // dragleave also fires when the pointer moves onto a child element; only a real exit counts.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragActive(false);
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragActive(false);
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
      className={`${styles.zone} ${dragActive ? styles.drag : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input type="file" multiple accept={ACCEPT} className={styles.input} onChange={onChange} />
      <span className={styles.title}>DROP PDF, DOCX OR IMAGES HERE</span>
      <span className={styles.sub}>or click to choose files · PDF, DOCX, JPG, PNG</span>
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
