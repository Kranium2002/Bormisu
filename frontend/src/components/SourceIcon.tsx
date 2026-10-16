import styles from './SourceIcon.module.css';

interface Props {
  onClick?: () => void;
  /** Faded, e.g. for a value that is not in the source. */
  dim?: boolean;
  title?: string;
}

/** Small document icon next to a value: opens the Source panel. Clicks don't reach the row below. */
export function SourceIcon({ onClick, dim = false, title = 'Show source' }: Props) {
  return (
    <button
      type="button"
      className={`${styles.icon} ${dim ? styles.dim : ''}`}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <span className={styles.sheet} />
    </button>
  );
}
