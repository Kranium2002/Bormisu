import type { ReactNode } from 'react';
import type { Certainty } from '../domain/certainty';
import { CertaintyMark } from './CertaintyMark';
import styles from './ValueCell.module.css';

interface Props {
  /** The value's status dot; null = no dot (nothing extracted). */
  certainty: Certainty | null;
  /** Opens the document view at this value; without it the cell is plain text. */
  onOpen?: () => void;
  className?: string;
  children: ReactNode;
}

/**
 * A value with its status dot in front. With `onOpen` the whole cell is one button: a click anywhere on it
 * shows where the value was read (the row's own click, e.g. selecting a layer, still happens).
 */
export function ValueCell({ certainty, onOpen, className = '', children }: Props) {
  const body = (
    <>
      {certainty && <CertaintyMark certainty={certainty} />}
      {children}
    </>
  );
  if (!onOpen) return <span className={`${styles.cell} ${className}`}>{body}</span>;
  return (
    <button type="button" className={`${styles.cell} ${styles.button} ${className}`} title="Show source" onClick={onOpen}>
      {body}
    </button>
  );
}
