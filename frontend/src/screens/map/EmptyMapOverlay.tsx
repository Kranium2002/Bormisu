import { useT } from '../../i18n';
import styles from './EmptyMapOverlay.module.css';

/**
 * Card over the middle of an empty map (no boreholes at all, the empty start): what to do, with a
 * button to the queue. The map around it keeps working (pan, zoom).
 */
export function EmptyMapOverlay({ onOpenQueue }: { onOpenQueue(): void }) {
  const t = useT();
  return (
    <div className={styles.wrap}>
      <div className={styles.card} role="status">
        <div className={styles.text}>{t('Upload a report to see boreholes here')}</div>
        <button type="button" className={styles.action} onClick={onOpenQueue}>
          {t('OPEN UPLOAD & QUEUE')}
        </button>
      </div>
    </div>
  );
}
