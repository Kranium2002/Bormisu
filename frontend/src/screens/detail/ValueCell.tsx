import type { ReactNode } from 'react';
import { CertaintyMark } from '../../components/CertaintyMark';
import type { Certainty } from '../../domain/certainty';
import { useT } from '../../i18n';
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
 * A value with its status dot in front. With `onOpen` the whole cell is one button: a click anywhere on
 * it opens the document view at the value (where it was read, and a field to correct it); the row's own
 * click, e.g. selecting the layer, still happens.
 */
export function ValueCell({ certainty, onOpen, className = '', children }: Props) {
  const t = useT();
  const body = (
    <>
      {certainty && <CertaintyMark certainty={certainty} />}
      {children}
    </>
  );
  if (!onOpen) return <span className={`${styles.cell} ${className}`}>{body}</span>;
  return (
    <button type="button" className={`${styles.cell} ${styles.button} ${className}`} title={t('Show source')} onClick={onOpen}>
      {body}
    </button>
  );
}
