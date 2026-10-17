import styles from './SourceIcon.module.css';

interface Props {
  /** Opens the source; without it the icon is disabled (nothing to open). */
  onClick?: () => void;
  /** Faded, e.g. for a value that is not in the source. */
  dim?: boolean;
  /** Accessible name and tooltip: what a click opens, or why there is nothing to open. */
  title?: string;
}

/**
 * Small document icon next to a value: opens the Source panel. Clicks don't reach the row below.
 * Without an action it is disabled, so no control looks clickable and does nothing.
 */
export function SourceIcon({ onClick, dim = false, title = 'Show source' }: Props) {
  return (
    <button
      type="button"
      className={`${styles.icon} ${dim ? styles.dim : ''}`}
      title={title}
      aria-label={title}
      disabled={!onClick}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <span className={styles.sheet} />
    </button>
  );
}
