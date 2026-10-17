import { useState, type ChangeEvent, type DragEvent } from 'react';
import { errorText } from '../../data/errors';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { acceptAttribute, uploadBlockedReason } from '../../store/uploads';
import { fill } from '../review/fill';
import { dropEntries, filesFromEntries, hasFolder, withoutHiddenFiles } from './dropEntries';
import styles from './DropZone.module.css';

/** Id of the drop zone's file input (focus goes back to it when the upload list empties). */
export const DROP_INPUT_ID = 'upload-files';
const PROJECT_ID = 'upload-project';
const PROJECT_HINT_ID = 'upload-project-hint';

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');

/** Sets the non-standard `webkitdirectory` attribute (folder picker), which React's types don't list. */
const folderPicker = (el: HTMLInputElement | null) => el?.setAttribute('webkitdirectory', '');

/**
 * Drop zone with the "Project (optional)" field and a folder picker. Accepted types and the size
 * limit come from the server's health answer (the file chooser filters by them; drops are checked by
 * the store, which explains refused files in red). Files added together send one project: the typed
 * label, else the dropped or picked folder's name. In demo mode (no provider keys) everything is
 * disabled with that reason.
 */
export function DropZone() {
  const t = useT();
  const dragActive = useAppStore((s) => s.dragActive);
  const dropError = useAppStore((s) => s.dropError);
  const addFiles = useAppStore((s) => s.addFiles);
  const setDragActive = useAppStore((s) => s.setDragActive);
  const project = useAppStore((s) => s.uploadProject);
  const setProject = useAppStore((s) => s.setUploadProject);
  const health = useAppStore((s) => s.health);
  const blockedReason = uploadBlockedReason(health);
  const blocked = blockedReason && t(blockedReason);
  const limits = health?.upload ?? null;
  const off = blocked ? fill(t('Uploading is off: {reason}.'), { reason: blocked }) : '';
  const hint = limits
    ? fill(t('or click to choose files · {types} · up to {mb} MB each'), {
        types: limits.extensions.map((e) => e.replace(/^./, '').toUpperCase()).join(', '),
        mb: limits.maxMb,
      })
    : t('or click to choose files');
  /** A dropped folder that could not be read. */
  const [readError, setReadError] = useState('');
  /** Folders still being read after a drop. */
  const [reading, setReading] = useState(0);

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
    setReadError('');
    // The entries must be taken while the event is handled; folders are read afterwards.
    const entries = dropEntries(e.dataTransfer);
    if (!hasFolder(entries)) {
      addFiles(Array.from(e.dataTransfer.files), { folder: null });
      return;
    }
    setReading((n) => n + 1);
    filesFromEntries(entries)
      .then(
        ({ files, folder }) => addFiles(files, { folder }),
        (err: unknown) => setReadError(`${t('Could not read the dropped folder')}: ${errorText(err)}`),
      )
      .finally(() => setReading((n) => n - 1));
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset so choosing the same file again fires another change.
    e.target.value = '';
    setReadError('');
    if (files.length) addFiles(files);
  };

  const onFolder = (e: ChangeEvent<HTMLInputElement>) => {
    // The store names the drop after the picked folder (webkitRelativePath).
    const files = withoutHiddenFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
    setReadError('');
    if (files.length) addFiles(files);
  };

  return (
    <div className={styles.upload}>
      <label
        className={`${styles.zone} ${dragActive ? styles.drag : ''} ${blocked ? styles.disabled : ''}`}
        aria-disabled={blocked ? true : undefined}
        title={blocked ?? undefined}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <input
          id={DROP_INPUT_ID}
          type="file"
          multiple
          accept={acceptAttribute(limits)}
          disabled={!!blocked}
          className={styles.input}
          onChange={onFiles}
        />
        <span className={styles.title}>{t('DROP REPORTS HERE')}</span>
        <span className={styles.sub}>{blocked ? off : hint}</span>
        {reading > 0 && (
          <span className={styles.reading} role="status">
            {t('Reading the dropped folder…')}
          </span>
        )}
        {(dropError || readError) && (
          <span className={styles.error} role="alert">
            {[dropError, readError].filter(Boolean).join(' · ')}
          </span>
        )}
      </label>
      <div className={styles.side}>
        <label className={styles.fieldLabel} htmlFor={PROJECT_ID}>
          {t('Project (optional)')}
        </label>
        <input
          id={PROJECT_ID}
          className={styles.field}
          value={project}
          maxLength={200}
          disabled={!!blocked}
          title={blocked ?? undefined}
          aria-describedby={PROJECT_HINT_ID}
          autoComplete="off"
          onChange={(e) => setProject(e.target.value)}
        />
        <span id={PROJECT_HINT_ID} className={styles.fieldHint}>
          {blocked ? off : t('Sent with the files you add next. Left empty, a dropped folder’s name is used.')}
        </span>
        <label className={`${styles.folder} ${blocked ? styles.folderDisabled : ''}`} title={blocked || t('Upload every file of a folder')}>
          <input
            ref={folderPicker}
            type="file"
            multiple
            disabled={!!blocked}
            className={styles.input}
            aria-label={t('Choose a folder to upload')}
            onChange={onFolder}
          />
          {t('CHOOSE A FOLDER')}
        </label>
      </div>
    </div>
  );
}
