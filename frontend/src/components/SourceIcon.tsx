import styles from './SourceIcon.module.css';

interface Props {
  /** Opens the source. Without it the icon is an inert image: it says a source exists but can't open it. */
  onClick?: () => void;
  /** Faded, e.g. for a value that is not in the source. */
  dim?: boolean;
  title?: string;
}

/** A page with a folded corner and two text lines, 12×14. Decorative: the wrapper carries the name. */
function PageGlyph() {
  return (
    <svg className={styles.glyph} width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true" focusable="false">
      <path d="M1.25 0.75H7.5L10.75 4V13.25H1.25Z" strokeLinejoin="round" />
      <path d="M7.5 0.75V4H10.75" strokeLinejoin="round" />
      <path d="M3.5 7.25H8.5M3.5 10H8.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Small document icon next to a value: opens the Source panel. Clicks don't reach the row below.
 * Without `onClick` it renders a non-interactive image (no tab stop) instead of a button that does nothing.
 */
export function SourceIcon({ onClick, dim = false, title = 'Show source' }: Props) {
  const cls = `${styles.icon} ${dim ? styles.dim : ''}`;
  if (!onClick) {
    return (
      <span className={`${cls} ${styles.inert}`} role="img" aria-label={title} title={title}>
        <PageGlyph />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <PageGlyph />
    </button>
  );
}
