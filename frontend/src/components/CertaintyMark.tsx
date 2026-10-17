import type { Certainty } from '../domain/certainty';
import styles from './CertaintyMark.module.css';

/** A small dot in front of a value: green sure · yellow unsure · red flagged · grey not in the source; why is in the tooltip. */
export function CertaintyMark({ certainty: c }: { certainty: Certainty }) {
  return <span className={`${styles.dot} ${styles[c.kind]}`} title={c.title} aria-label={c.title} role="img" />;
}
