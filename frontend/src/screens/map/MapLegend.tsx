import { useId, useMemo, type Ref } from 'react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { useColourMode } from './canvas/colourMode';
import styles from './MapLegend.module.css';
import { legendRows, mapRows, type ColourBy, type LegendEntry } from './mapModel';

interface Props {
  ref?: Ref<HTMLDivElement>;
  /**
   * Not needed any more: the legend reads the pins, the active result set and the colour mode from
   * the stores itself. Accepted so callers from before the colour switch keep compiling.
   */
  entries?: LegendEntry[];
}

const MODES: { value: ColourBy; label: string }[] = [
  { value: 'status', label: 'STATUS' },
  { value: 'depth', label: 'DEPTH' },
];

/**
 * Legend over the bottom-left of the map, with the "Colour by: status | depth" switch (FRONTEND.md
 * F9): one row per colour class with the number of pins in it. Counted are the pins on the map, or
 * the highlighted members while a result set is active. The counts are announced (aria-live) as they
 * change. The map measures the legend (`ref`) to keep pins out from under it when it fits them.
 */
export function MapLegend({ ref }: Props) {
  const colourBy = useColourMode((s) => s.colourBy);
  const setColourBy = useColourMode((s) => s.setColourBy);
  const features = useAppStore((s) => s.features);
  const boreholes = useAppStore((s) => s.boreholes);
  const unplottedUids = useAppStore((s) => s.unplottedUids);
  const resultSet = useAppStore((s) => s.resultSet);
  const t = useT();
  const name = useId();
  const titleId = useId();
  const switchId = useId();

  const pins = useMemo(() => mapRows(features, boreholes, unplottedUids).pins, [features, boreholes, unplottedUids]);
  const members = useMemo(() => (resultSet ? new Set(resultSet.uids) : null), [resultSet]);
  const rows = useMemo(() => legendRows(pins, colourBy, members), [pins, colourBy, members]);

  // With a result set active, the counts are its members'.
  const title = members ? (colourBy === 'status' ? 'SELECTION · STATUS' : 'SELECTION · DEPTH') : colourBy === 'status' ? 'REVIEW STATUS' : 'FINAL DEPTH';
  return (
    <div
      ref={ref}
      className={styles.legend}
      role="group"
      aria-label={colourBy === 'status' ? 'Review status legend' : 'Final depth legend'}
      data-colour-by={colourBy}
    >
      <div className={styles.switch}>
        <span className={styles.switchLabel} id={switchId}>
          {t('COLOUR BY')}
        </span>
        <div className={styles.options} role="radiogroup" aria-labelledby={switchId}>
          {MODES.map((m) => (
            <label key={m.value} className={`${styles.option} ${colourBy === m.value ? styles.checked : ''}`}>
              <input
                type="radio"
                className={styles.radio}
                name={name}
                value={m.value}
                checked={colourBy === m.value}
                onChange={() => setColourBy(m.value)}
              />
              {t(m.label)}
            </label>
          ))}
        </div>
      </div>
      <div className={styles.title} id={titleId}>
        {t(title)}
      </div>
      {/* The counts change with uploads, reviews and selections: screen readers hear them (FRONTEND.md section 6). */}
      <ul className={styles.list} aria-labelledby={titleId} aria-live="polite">
        {rows.map((r) => (
          <li key={r.key} className={styles.row} data-key={r.key} data-status={r.status}>
            <span className={styles.dot} style={{ background: r.paint.fill, borderColor: r.paint.stroke }} aria-hidden="true" />
            <span className={styles.label}>{t(r.label)}</span>
            <span className={styles.count}>{r.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
