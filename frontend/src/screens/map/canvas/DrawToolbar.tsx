import type { ReactNode } from 'react';
import { useT } from '../../../i18n';
import type { DrawShape } from './drawTools';
import styles from './DrawToolbar.module.css';

interface Props {
  /** The shape being drawn, or null. */
  mode: DrawShape | null;
  /** An area is selected on the map (drawn, or echoed by the active result set). */
  areaShown: boolean;
  onDraw(shape: DrawShape): void;
  onCancel(): void;
  onRemoveArea(): void;
}

const TOOLS: { shape: DrawShape; label: string; hint: string; icon: ReactNode }[] = [
  {
    shape: 'rectangle',
    label: 'Select by rectangle',
    hint: 'Click two opposite corners. Esc cancels.',
    icon: <rect x="3.5" y="5.5" width="13" height="9" />,
  },
  {
    shape: 'polygon',
    label: 'Select by polygon',
    hint: 'Click the corners, then the first corner again (or press Enter) to finish. Esc cancels.',
    icon: <path d="M4 14.5 6 5l7.5-1.5 2.5 8-6 4z" />,
  },
  {
    shape: 'circle',
    label: 'Select by circle',
    hint: 'Click the centre, then the edge. Esc cancels.',
    icon: <circle cx="10" cy="10" r="6.5" />,
  },
];

/**
 * Area selection tools on the map (top right, as LGRB's): rectangle, polygon and circle, each a
 * toggle with an accessible name; clicking the active one cancels. While drawing, a hint says how
 * (announced). When an area is selected, a delete button removes it. Drawing needs a pointer; the
 * keyboard path to the same selection is the filter panel and the results table.
 */
export function DrawToolbar({ mode, areaShown, onDraw, onCancel, onRemoveArea }: Props) {
  const active = TOOLS.find((t) => t.shape === mode);
  const tr = useT();
  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar} role="toolbar" aria-label="Select an area" aria-orientation="vertical">
        {TOOLS.map((t) => (
          <button
            key={t.shape}
            type="button"
            className={`${styles.tool} ${mode === t.shape ? styles.active : ''}`}
            aria-label={t.label}
            aria-pressed={mode === t.shape}
            title={tr(t.label)}
            onClick={() => (mode === t.shape ? onCancel() : onDraw(t.shape))}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.icon}>
              {t.icon}
            </svg>
          </button>
        ))}
        {areaShown && (
          <button type="button" className={`${styles.tool} ${styles.remove}`} aria-label="Remove the selected area" title={tr('Remove the selected area')} onClick={onRemoveArea}>
            <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.icon}>
              <path d="M5 6.5h10M8 6.5V4.5h4v2M6.5 6.5l.8 9h5.4l.8-9" />
            </svg>
          </button>
        )}
      </div>
      <div className={styles.hint} role="status">
        {active ? tr(active.hint) : ''}
      </div>
    </div>
  );
}
