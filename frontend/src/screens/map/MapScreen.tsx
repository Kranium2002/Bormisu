/**
 * Map screen in frontend_din's look: the map fills the screen (FRONTEND.md section 6, F9 to F11).
 * Over it: the zoom and FILTERS buttons top left (FILTERS opens PLACE SEARCH and FILTERS as a panel
 * over the map and counts the active filters), the active result set as a chip at the top ("5
 * boreholes · OPEN LIST ›", CLEAR), the legend bottom left (REVIEW STATUS with its counts, colour by
 * STATUS | DEPTH) and the area tools on the right edge. The table of results and the boreholes that
 * are not on the map are in LIST.
 *
 * The header search filters while it is typed: only the matching pins stay, drawn larger.
 *
 * The map canvas (pins, clusters, colours, legend, popups, draw tools, fly-to and outlines) is
 * BoreholeMap's; new map behaviour comes through the store (mapOutline, resultSet). The URL holds
 * the map's state (/map?at=lat,lng,zoom&sel=uid&rs=result set): pan and zoom write `at`, a selected
 * pin `sel`, a result set `rs`, and a reload or Back restores them.
 */
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { isFilterQuery, matchesQuery } from '../../domain/search';
import { useT } from '../../i18n';
import { ROUTE } from '../../routing/urlState';
import { useAppStore } from '../../store/appStore';
import { BoreholeMap } from './BoreholeMap';
import { EmptyMapOverlay } from './EmptyMapOverlay';
import { ExplorePanel } from './explore/ExplorePanel';
import { activeFilterCount } from './explore/filterModel';
import { ResultSetSummary } from './explore/ResultSetSummary';
import { MapLegend } from './MapLegend';
import { mapRows } from './mapModel';
import styles from './MapScreen.module.css';

export function MapScreen() {
  const t = useT();
  const features = useAppStore((s) => s.features);
  const boreholes = useAppStore((s) => s.boreholes);
  const unplottedUids = useAppStore((s) => s.unplottedUids);
  const reviewUid = useAppStore((s) => s.reviewUid);
  const mapFocus = useAppStore((s) => s.mapFocus);
  const mapView = useAppStore((s) => s.mapView);
  const selectedUid = useAppStore((s) => s.selectedUid);
  const query = useAppStore((s) => s.query);
  const filter = useAppStore((s) => s.filter);
  const resultSet = useAppStore((s) => s.resultSet);
  const resultSetBusy = useAppStore((s) => s.resultSetBusy);
  const resultSetError = useAppStore((s) => s.resultSetError);
  const openBorehole = useAppStore((s) => s.openBorehole);
  const setMapView = useAppStore((s) => s.setMapView);
  const selectOnMap = useAppStore((s) => s.selectOnMap);
  const clearResultSet = useAppStore((s) => s.clearResultSet);
  const go = useAppStore((s) => s.go);
  const legendRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const { rows, pins } = useMemo(() => mapRows(features, boreholes, unplottedUids), [features, boreholes, unplottedUids]);
  const searching = isFilterQuery(query);
  // While the header search holds a query, only the matching pins stay on the map.
  const shownPins = useMemo(() => (searching ? pins.filter((p) => matchesQuery(p, query)) : pins), [pins, query, searching]);
  const filters = activeFilterCount(filter);

  const closePanel = () => {
    setPanelOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div className={styles.screen} data-screen-label="Map">
      <BoreholeMap
        pins={shownPins}
        searchActive={searching}
        highlightUid={reviewUid}
        focus={mapFocus}
        view={mapView}
        selectedUid={selectedUid}
        legendRef={legendRef}
        onOpen={openBorehole}
        onViewChange={setMapView}
        onSelect={selectOnMap}
      />
      <div className={styles.controls}>
        <button
          ref={toggleRef}
          type="button"
          className={`${styles.toggle} ${panelOpen ? styles.toggleOpen : ''}`}
          aria-expanded={panelOpen}
          aria-controls="explore-panel"
          aria-label={filters ? `${t('FILTERS')}, ${filters} ${t('active')}` : t('FILTERS')}
          onClick={() => setPanelOpen((o) => !o)}
        >
          {t('FILTERS')}
          {filters > 0 && (
            <span className={styles.count} aria-hidden="true">
              {filters}
            </span>
          )}
        </button>
        <ExplorePanel open={panelOpen} onClose={closePanel} />
      </div>
      <div className={`${styles.summary} ${resultSet || resultSetBusy || resultSetError ? styles.summaryOn : ''}`}>
        <ResultSetSummary
          resultSet={resultSet}
          busy={resultSetBusy}
          error={resultSetError}
          onClear={clearResultSet}
          compact
          extra={
            resultSet && (
              <Link className={styles.openList} to={`/${ROUTE.list}`}>
                {t('OPEN LIST ›')}
              </Link>
            )
          }
        />
      </div>
      {searching && (
        <p className={styles.searchNote} role="status">
          {shownPins.length === 0
            ? `${t('No borehole on the map matches')} “${query.trim()}”`
            : `${shownPins.length} ${t(shownPins.length === 1 ? 'borehole matches the search' : 'boreholes match the search')}`}
        </p>
      )}
      <MapLegend ref={legendRef} />
      {rows.length === 0 && <EmptyMapOverlay onOpenQueue={() => go('queue')} />}
    </div>
  );
}
