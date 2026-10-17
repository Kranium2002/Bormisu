import type { Chip } from './detailModel';
import styles from './cards.module.css';

const TONE = { red: styles.chipRed, amber: styles.chipAmber, green: styles.chipGreen, grey: styles.chipGrey } as const;

/** Small status chips next to a value, in sentence case: Lint, Datum unconfirmed, Inferred / Confirmed / Stated … */
export function Chips({ chips }: { chips: Chip[] }) {
  return chips.map((c) => (
    <span key={c.label} className={`${styles.chip} ${TONE[c.tone]}`} title={c.title}>
      {c.label}
    </span>
  ));
}
