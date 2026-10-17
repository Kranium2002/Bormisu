import type { Method } from '../domain/types';
import { METHOD_COLORS } from '../theme';
import styles from './MethodBadge.module.css';

interface Props {
  method: Method;
  /** 0–1; shown only on hover, never as a colour. */
  confidence?: number;
  /** Formula of a Derived value, appended to the hover text. */
  formula?: string;
}

/** Hover text of a method badge: "82 % confidence · derived: …". */
export function methodTitle(confidence?: number, formula?: string): string | undefined {
  if (confidence == null) return undefined;
  return `${Math.round(confidence * 100)} % confidence${formula ? ` · derived: ${formula}` : ''}`;
}

/** Read / OCR / Derived / Guessed / Edited badge. The confidence % is only in the tooltip. */
export function MethodBadge({ method, confidence, formula }: Props) {
  const c = METHOD_COLORS[method];
  return (
    <span className={styles.badge} style={{ background: c.bg, color: c.fg }} title={methodTitle(confidence, formula)}>
      {method}
    </span>
  );
}
