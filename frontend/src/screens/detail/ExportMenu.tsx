import { useEffect, useRef } from 'react';
import { Popover } from '../../components/Popover';
import { Toggle } from '../../components/Toggle';
import type { Borehole } from '../../domain/types';
import { useAppStore, type ExportKind } from '../../store/appStore';
import { exportScope } from '../../export/scope';
import { excludedText, unreviewedCount } from './detailModel';
import styles from './ExportMenu.module.css';

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
 */
export function ExportMenu({ borehole }: Props) {
  const open = useAppStore((s) => s.exportOpen);
  const toggleExport = useAppStore((s) => s.toggleExport);
  const include = useAppStore((s) => s.includeUnreviewed);
  const toggleInclude = useAppStore((s) => s.toggleIncludeUnreviewed);
  const exportFile = useAppStore((s) => s.exportFile);
  const unreviewed = useAppStore((s) => unreviewedCount(exportScope(s.boreholes, borehole)));
  const scopeSize = useAppStore((s) => exportScope(s.boreholes, borehole).length);
  const wrapRef = useRef<HTMLDivElement>(null);

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
              <span className={`${styles.includeNote} ${include ? styles.draft : ''}`}>{excludedText(unreviewed, include, scopeSize)}</span>
            </label>
          </div>
        </Popover>
      )}
    </div>
  );
}
