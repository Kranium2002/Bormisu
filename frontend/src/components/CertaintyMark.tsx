import type { MouseEvent } from 'react';
import type { Certainty } from '../domain/certainty';
import styles from './CertaintyMark.module.css';

interface Props {
  certainty: Certainty;
  /** Opens the value's source page; without it the dot is only a status light. */
  onOpen?: () => void;
}

/**
 * A small dot in front of a value: green sure · yellow unsure · red flagged · grey not in the source.
 * Why is in the tooltip; with `onOpen` a click shows where the value was read.
 */
export function CertaintyMark({ certainty: c, onOpen }: Props) {
  const cls = `${styles.dot} ${styles[c.kind]}`;
  if (!onOpen) return <span className={cls} title={c.title} aria-label={c.title} role="img" />;
  const open = (e: MouseEvent) => {
    e.stopPropagation(); // the row's own click selects it
    onOpen();
  };
  return <button type="button" className={`${cls} ${styles.button}`} title={`${c.title} · click for the source`} aria-label={`${c.title}: show source`} onClick={open} />;
}
