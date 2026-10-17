import { useT } from '../i18n';
import styles from './EmptyState.module.css';

interface Props {
  title: string;
  message?: string;
  tone?: 'neutral' | 'error';
  action?: { label: string; onClick: () => void };
}

/** Centred message filling its container: loading, errors, empty screens. Texts are English keys, shown translated. */
export function EmptyState({ title, message, tone = 'neutral', action }: Props) {
  const t = useT();
  return (
    <div className={styles.wrap} role={tone === 'error' ? 'alert' : 'status'}>
      <div className={styles.card}>
        <div className={`${styles.title} ${tone === 'error' ? styles.error : ''}`}>{t(title)}</div>
        {message && <div className={styles.message}>{t(message)}</div>}
        {action && (
          <button type="button" className={styles.action} onClick={action.onClick}>
            {t(action.label)}
          </button>
        )}
      </div>
    </div>
  );
}
