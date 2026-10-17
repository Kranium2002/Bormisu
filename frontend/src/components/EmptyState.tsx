import { Fragment, type ReactNode } from 'react';
import styles from './EmptyState.module.css';

interface Props {
  title: string;
  message?: ReactNode;
  tone?: 'neutral' | 'error';
  action?: { label: string; onClick: () => void };
}

/** `npm run <script>` commands and `/api/...` paths: the parts of a message a reader types or looks up. */
const CODE_RE = /npm run [\w:-]+|\/api(?:\/[^\s/]+)*/g;
/** Sentence punctuation right after a path belongs to the sentence, not the path. */
const TRAILING_PUNCT = /[.,;:!?)]+$/;

/**
 * Wraps the `npm run <script>` commands and `/api/...` paths of a message in <code>, so a reader
 * can tell what to type. The rest stays plain text.
 */
export function withInlineCode(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CODE_RE)) {
    const code = m[0].replace(TRAILING_PUNCT, '');
    if (!code || code === '/api') continue;
    const start = m.index;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <code key={start} className={styles.code}>
        {code}
      </code>,
    );
    last = start + code.length;
  }
  if (last === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((p, i) => (typeof p === 'string' ? <Fragment key={`t${i}`}>{p}</Fragment> : p));
}

/** Centred message filling its container: loading, errors, empty screens. */
export function EmptyState({ title, message, tone = 'neutral', action }: Props) {
  return (
    <div className={styles.wrap} role={tone === 'error' ? 'alert' : 'status'}>
      <div className={styles.card}>
        <div className={`${styles.title} ${tone === 'error' ? styles.error : ''}`}>{title}</div>
        {message && <div className={styles.message}>{message}</div>}
        {action && (
          <button type="button" className={styles.action} onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
