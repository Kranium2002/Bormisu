import type { MyLocation } from '../../store/appStore';
import styles from './MyLocationControl.module.css';

interface Props {
  state: MyLocation;
  onLocate(): void;
  /** Sample mode only: the demo site's name (e.g. "Neckarbogen site"), else null and no option. */
  simulateLabel: string | null;
  onSimulate(): void;
}

/** Crosshair: a circle with four ticks and a centre dot. */
function CrosshairIcon() {
  return (
    <svg className={styles.icon} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      <path d="M8 0.5v3M8 12.5v3M0.5 8h3M12.5 8h3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/**
 * MY LOCATION, a Leaflet control under the zoom buttons (BoreholeMap renders it into the control's
 * element). Shows "Locating…" and why locating failed right under the button.
 */
export function MyLocationControl({ state, onLocate, simulateLabel, onSimulate }: Props) {
  const locating = state.status === 'locating';
  return (
    <div className={styles.control}>
      <div className={styles.row}>
        <button type="button" className={styles.button} onClick={onLocate} disabled={locating} aria-busy={locating}>
          <CrosshairIcon />
          MY LOCATION
        </button>
        {simulateLabel && (
          <button type="button" className={styles.simulate} onClick={onSimulate}>
            <span className={styles.demoTag} aria-hidden="true">
              DEMO
            </span>
            Simulate: {simulateLabel}
          </button>
        )}
      </div>
      {(state.status === 'locating' || state.status === 'error') && (
        <div role="status" className={`${styles.message} ${state.status === 'error' ? styles.error : ''}`}>
          {state.status === 'locating' ? 'Locating…' : state.message}
        </div>
      )}
    </div>
  );
}
