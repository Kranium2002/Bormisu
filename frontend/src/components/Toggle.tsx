import styles from './Toggle.module.css';

interface Props {
  on: boolean;
  onToggle: () => void;
  /** Accessible name; or point a <label htmlFor={id}> at it. */
  label?: string;
  id?: string;
}

/** On/off switch (amber when on), as in the export menu's "Include unreviewed values". */
export function Toggle({ on, onToggle, label, id }: Props) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={on}
      aria-label={label}
      className={`${styles.track} ${on ? styles.on : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <span className={styles.knob} />
    </button>
  );
}
