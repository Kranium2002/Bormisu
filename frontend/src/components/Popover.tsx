import type { ReactNode } from 'react';
import styles from './Popover.module.css';

interface Props {
  /** Width in px (prototype: 300 for "approve all clean", 360 for the export menu). */
  width: number;
  /** Offset below the anchor's top edge, px. */
  top?: number;
  label: string;
  className?: string;
  children: ReactNode;
}

/**
 * Floating card anchored to the right edge of a `position: relative` parent.
 * The content sets its own padding and layout. Escape handling lives in the store.
 */
export function Popover({ width, top = 46, label, className, children }: Props) {
  return (
    <div role="dialog" aria-label={label} className={`${styles.popover} ${className ?? ''}`} style={{ width, top }}>
      {children}
    </div>
  );
}
