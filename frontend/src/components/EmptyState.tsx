import styles from './EmptyState.module.css';

interface Props {
  title: string;
  message?: string;
  tone?: 'neutral' | 'error';
  action?: { label: string; onClick: () => void };
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
