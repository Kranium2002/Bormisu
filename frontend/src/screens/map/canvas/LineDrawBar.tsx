import { useT } from '../../../i18n';
import styles from './LineDrawBar.module.css';

export const LINE_DRAW_HINT = 'Click to add points · double-click or Enter to finish · Esc to cancel';

interface Props {
  /** Points of the line so far. */
  points: number;
  onFinish(): void;
  onCancel(): void;
}

/**
 * While a planned line is drawn: how to draw it, FINISH (from the second point on, as a double-click
 * or Enter would) and CANCEL (as Esc). It sits over the top centre of the map, outside Leaflet's
 * element, so its clicks never add a point.
 */
export function LineDrawBar({ points, onFinish, onCancel }: Props) {
  const t = useT();
  return (
    <div className={styles.bar} role="toolbar" aria-label="Drawing a planned line" data-testid="line-draw-bar">
      <span className={styles.hint} role="status">
        {t(LINE_DRAW_HINT)}
      </span>
      <button type="button" className={styles.primary} disabled={points < 2} onClick={onFinish}>
        {t('FINISH')}
      </button>
      <button type="button" className={styles.secondary} onClick={onCancel}>
        {t('CANCEL')}
      </button>
    </div>
  );
}
