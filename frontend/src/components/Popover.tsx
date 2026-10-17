import { useRef, type ReactNode } from 'react';
import styles from './Popover.module.css';
import { useDialogFocus } from './useDialogFocus';

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
 * The content sets its own padding and layout. Focus moves into it when it opens (unless the content
 * autoFocuses something) and back to the opener when it closes; Tab isn't trapped. Escape handling
 * lives in the store.
 */
export function Popover({ width, top = 46, label, className, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref);
  return (
    <div ref={ref} role="dialog" aria-label={label} className={`${styles.popover} ${className ?? ''}`} style={{ width, top }}>
      {children}
    </div>
  );
}
