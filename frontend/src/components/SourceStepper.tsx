import { useT } from '../i18n';
import styles from './SourceStepper.module.css';

interface Props {
  /** 0-based source shown. */
  index: number;
  count: number;
  /** The page of the source shown. */
  page: number | null;
  onStep(index: number): void;
  /** Extra class for the group, e.g. its margin in the surrounding layout. */
  className?: string;
}

/**
 * ‹ source i of N · page n › for a value cited on several pages: steps to the previous or next
 * source (disabled at either end). Used by the Source panel and the sheet's Source pane.
 */
export function SourceStepper({ index, count, page, onStep, className }: Props) {
  const t = useT();
  return (
    <div className={`${styles.stepper} ${className ?? ''}`} role="group" aria-label={t('Sources of this value')}>
      <button
        type="button"
        className={styles.stepButton}
        aria-label={t('Previous source')}
        disabled={index === 0}
        onClick={() => onStep(index - 1)}
      >
        ‹
      </button>
      <span className={styles.stepText} aria-live="polite">
        {t('source')} {index + 1} {t('of')} {count} · {t('page')} {page}
      </span>
      <button
        type="button"
        className={styles.stepButton}
        aria-label={t('Next source')}
        disabled={index >= count - 1}
        onClick={() => onStep(index + 1)}
      >
        ›
      </button>
    </div>
  );
}
