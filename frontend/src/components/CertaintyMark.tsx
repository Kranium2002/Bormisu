import type { Certainty, CertaintyKind } from '../domain/certainty';
import styles from './CertaintyMark.module.css';

const GLYPH: Record<CertaintyKind, string> = { sure: '✓', unsure: '?', flagged: '!', missing: '–' };

/** Green ✓ sure · yellow ? unsure · red ! flagged · grey – not in the source; why is in the tooltip. */
export function CertaintyMark({ certainty: c }: { certainty: Certainty }) {
  return (
    <span className={`${styles.mark} ${styles[c.kind]}`} title={c.title} aria-label={c.title} role="img">
      {GLYPH[c.kind]}
    </span>
  );
}
