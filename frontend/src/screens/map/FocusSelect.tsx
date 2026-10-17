import type { MapFocus } from '../../geo/mapFocus';
import styles from './FocusSelect.module.css';
import type { FocusOption } from './mapModel';

interface Props {
  value: MapFocus;
  options: FocusOption[];
  onChange(focus: MapFocus): void;
  /** Shown under the select, e.g. while the outlines load or when they failed. */
  note?: string | null;
}

/**
 * MAP FOCUS dropdown over the top-left of the map, next to the zoom buttons: World, or one country
 * with its pin count. A native select, so keyboard and screen readers work as everywhere else.
 */
export function FocusSelect({ value, options, onChange, note }: Props) {
  return (
    <div className={styles.box}>
      <label htmlFor="map-focus" className={styles.label}>
        MAP FOCUS
      </label>
      <select
        id="map-focus"
        className={styles.select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={note ? 'map-focus-note' : undefined}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {note && (
        <div id="map-focus-note" className={styles.note}>
          {note}
        </div>
      )}
    </div>
  );
}
