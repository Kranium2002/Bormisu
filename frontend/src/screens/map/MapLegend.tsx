import { useId, useMemo, type Ref } from 'react';
import { Link } from 'react-router';
import { isFilterQuery, matchesQuery } from '../../domain/search';
import { useT } from '../../i18n';
import { ROUTE } from '../../routing/urlState';
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
 * F9): one row per colour class with the number of boreholes in it, placed on the map or not (only
 * the matching ones while the header search holds a query), or the members while a result set is
 * active. A row whose boreholes are not all placed says how many are on the map. The counts are
 * announced (aria-live) as they change. The map measures the legend (`ref`) to keep pins out from
 * under it when it fits them.
 */
export function MapLegend({ ref }: Props) {
  const colourBy = useColourMode((s) => s.colourBy);
  const setColourBy = useColourMode((s) => s.setColourBy);
  const features = useAppStore((s) => s.features);
  const boreholes = useAppStore((s) => s.boreholes);
  const unplottedUids = useAppStore((s) => s.unplottedUids);
  const resultSet = useAppStore((s) => s.resultSet);
  const query = useAppStore((s) => s.query);
  const t = useT();
  const name = useId();
  const titleId = useId();
  const switchId = useId();

  const { rows: all, notOnMap } = useMemo(() => mapRows(features, boreholes, unplottedUids), [features, boreholes, unplottedUids]);
  // While the header search holds a query only the matching boreholes count (the map keeps only their pins).
  const shown = useMemo(() => (isFilterQuery(query) ? all.filter((r) => matchesQuery(r, query)) : all), [all, query]);
  const members = useMemo(() => (resultSet ? new Set(resultSet.uids) : null), [resultSet]);
  const rows = useMemo(() => legendRows(shown, colourBy, members), [shown, colourBy, members]);

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
            {r.onMap < r.count && (
              <span className={styles.onMap}>
                {r.onMap} {t('on map')}
              </span>
            )}
          </li>
        ))}
      </ul>
      {/* The boreholes without usable coordinates are never placed: LIST shows them with the reason. */}
      <div className={styles.offMap}>
        <h2 className={styles.offTitle}>
          {t('NOT ON MAP')} ({notOnMap.length})
        </h2>
        {notOnMap.length > 0 && (
          <Link className={styles.offLink} to={`/${ROUTE.list}`}>
            {t('LIST ›')}
          </Link>
        )}
      </div>
    </div>
  );
}
