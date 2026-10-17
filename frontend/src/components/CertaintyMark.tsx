import type { Certainty } from '../domain/certainty';
import styles from './CertaintyMark.module.css';

/** Green ✓ (reviewed or AI sure) or yellow ? (AI unsure); why is in the tooltip. */
export function CertaintyMark({ certainty: c }: { certainty: Certainty }) {
  return (
    <span className={`${styles.mark} ${c.sure ? styles.sure : styles.unsure}`} title={c.title} aria-label={c.title} role="img">
      {c.sure ? '✓' : '?'}
    </span>
  );
}
