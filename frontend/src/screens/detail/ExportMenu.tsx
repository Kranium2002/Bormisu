import { useEffect, useRef, useState } from 'react';
import { Popover } from '../../components/Popover';
import { Toggle } from '../../components/Toggle';
import { errorText } from '../../data/errors';
import type { Borehole } from '../../domain/types';
import { useAppStore, type ExportKind } from '../../store/appStore';
import { exportScope } from '../../export/scope';
import { excludedText, unreviewedCount } from './detailModel';
import styles from './ExportMenu.module.css';

/** The count line while the document's records load, and when they could not be loaded. */
export const COUNTING_TEXT = 'Loading the report’s boreholes to count their values…';
export const countFailedText = (reason: string) => `Could not load the report’s boreholes: ${reason}`;

const OPTIONS: { kind: ExportKind; label: string; desc: string }[] = [
  { kind: 'xlsx', label: 'Project xlsx (target format)', desc: 'Metadata, Log and Tests sheets as in the template, plus a Provenance sheet' },
  { kind: 'csv', label: 'Tidy CSV', desc: 'One row per value, for your own tools' },
  { kind: 'questions', label: 'Open questions (CSV)', desc: 'Flags, illegible values, inferred CRS, missing IDs: the client RFI list' },
];

interface Props {
  borehole: Borehole;
}

/**
 * EXPORT ▾ button with its menu: the three exports of the borehole's project (same scope as the
 * store's exportFile) and the "Include unreviewed values" switch. Off by default; on stamps DRAFT.
 * Opening the menu loads the full records of the borehole's document (once; then cached), so the
 * count of excluded values covers every borehole the export will hold.
 */
export function ExportMenu({ borehole }: Props) {
  const open = useAppStore((s) => s.exportOpen);
  const toggleExport = useAppStore((s) => s.toggleExport);
  const include = useAppStore((s) => s.includeUnreviewed);
  const toggleInclude = useAppStore((s) => s.toggleIncludeUnreviewed);
  const exportFile = useAppStore((s) => s.exportFile);
  const ensureDocumentBoreholes = useAppStore((s) => s.ensureDocumentBoreholes);
  const unreviewed = useAppStore((s) => unreviewedCount(exportScope(s.boreholes, borehole)));
  const scopeSize = useAppStore((s) => exportScope(s.boreholes, borehole).length);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** The document's records: 'ready' once loaded, else 'loading' or the failure. */
  const [records, setRecords] = useState<{ documentId: string | null; state: 'loading' | 'ready' | string }>({ documentId: null, state: 'ready' });
  const documentId = borehole.documentId;

  useEffect(() => {
    if (!open || !documentId) return;
    let live = true;
    setRecords({ documentId, state: 'loading' });
    ensureDocumentBoreholes(documentId).then(
      () => live && setRecords({ documentId, state: 'ready' }),
      (e: unknown) => live && setRecords({ documentId, state: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [open, documentId, ensureDocumentBoreholes]);

  const counting = records.documentId === documentId && records.state === 'loading';
  const failed = records.documentId === documentId && records.state !== 'loading' && records.state !== 'ready' ? records.state : null;
  const note = counting ? COUNTING_TEXT : failed ? countFailedText(failed) : excludedText(unreviewed, include, scopeSize);

  // A click anywhere outside the button and menu closes the menu (Esc is handled by the store).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) toggleExport();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, toggleExport]);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button type="button" className={styles.button} aria-haspopup="dialog" aria-expanded={open} onClick={toggleExport}>
        EXPORT ▾
      </button>
      {open && (
        <Popover width={360} label="Export">
          <div className={styles.head}>EXPORT PROJECT · {borehole.project.toUpperCase()}</div>
          {OPTIONS.map((o) => (
            <button key={o.kind} type="button" className={styles.option} onClick={() => void exportFile(o.kind)}>
              <span className={styles.optionLabel}>{o.label}</span>
              <span className={styles.optionDesc}>{o.desc}</span>
            </button>
          ))}
          <div className={styles.include} onClick={toggleInclude}>
            <Toggle on={include} onToggle={toggleInclude} id="export-include-unreviewed" />
            <label className={styles.includeText} htmlFor="export-include-unreviewed" onClick={(e) => e.stopPropagation()}>
              <span className={styles.includeLabel}>Include unreviewed values</span>
              <span className={`${styles.includeNote} ${include && !counting && !failed ? styles.draft : ''}`} aria-live="polite">
                {note}
              </span>
            </label>
          </div>
        </Popover>
      )}
    </div>
  );
}
