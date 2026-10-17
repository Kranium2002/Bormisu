/**
 * Map screen, LGRB's information architecture in Bormisu's look (FRONTEND.md section 6, F9 to F11):
 * the explore panel on the left (PLACE SEARCH and FILTERS), the map in the centre, and under the map
 * the RESULTS table with the active result set's summary next to NOT ON MAP (boreholes without usable
 * coordinates, with their reason; never placed). Below 1280 px the explore panel opens over the map
 * from a SEARCH & FILTERS toggle, below 768 px as a full-screen sheet, and the page stacks map,
 * results and NOT ON MAP.
 *
 * The map canvas (pins, clusters, colours, legend, popups, draw tools, fly-to and outlines) is
 * BoreholeMap's; new map behaviour comes through the store (mapOutline, resultSet). The URL holds
 * the map's state (/map?at=lat,lng,zoom&sel=uid&rs=result set): pan and zoom write `at`, a selected
 * pin `sel`, a result set `rs`, and a reload or Back restores them.
 */
import { useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { BoreholeMap } from './BoreholeMap';
import { EmptyMapOverlay } from './EmptyMapOverlay';
import { ExplorePanel, overlayLayout } from './explore/ExplorePanel';
import { ResultSetSummary } from './explore/ResultSetSummary';
import { allRows, resultSetRows } from './explore/resultsModel';
import { MapLegend } from './MapLegend';
import { legendEntries, mapRows } from './mapModel';
import styles from './MapScreen.module.css';
import { NotOnMapList } from './NotOnMapList';
import { ResultsTable } from './ResultsTable';

export function MapScreen() {
  const features = useAppStore((s) => s.features);
  const boreholes = useAppStore((s) => s.boreholes);
  const unplottedUids = useAppStore((s) => s.unplottedUids);
  const documents = useAppStore((s) => s.documents);
  const reviewUid = useAppStore((s) => s.reviewUid);
  const mapFocus = useAppStore((s) => s.mapFocus);
  const mapView = useAppStore((s) => s.mapView);
  const selectedUid = useAppStore((s) => s.selectedUid);
  const resultSet = useAppStore((s) => s.resultSet);
  const resultSetFeatures = useAppStore((s) => s.resultSetFeatures);
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

  const { rows, pins, notOnMap } = useMemo(() => mapRows(features, boreholes, unplottedUids), [features, boreholes, unplottedUids]);
  const legend = useMemo(() => legendEntries(pins), [pins]);
  // The table: the active result set's members, else every borehole the map knows.
  const tableRows = useMemo(
    () =>
      resultSet && resultSetFeatures
        ? resultSetRows(resultSet, resultSetFeatures, features, boreholes, documents)
        : allRows(features, boreholes, unplottedUids, documents),
    [resultSet, resultSetFeatures, features, boreholes, unplottedUids, documents],
  );

  const closePanel = () => {
    setPanelOpen(false);
    toggleRef.current?.focus();
  };
  // Once the map flew to a place or a filter ran, a panel over the map gets out of its way.
  const panelDone = () => {
    if (panelOpen && overlayLayout()) closePanel();
  };

  return (
    <div className={styles.screen} data-screen-label="Map">
      <ExplorePanel open={panelOpen} onClose={closePanel} onDone={panelDone} />
      <div className={styles.centre}>
        <div className={styles.toolbar}>
          <button
            ref={toggleRef}
            type="button"
            className={styles.toggle}
            aria-expanded={panelOpen}
            aria-controls="explore-panel"
            onClick={() => setPanelOpen((o) => !o)}
          >
            SEARCH &amp; FILTERS
          </button>
          {resultSet && <span className={styles.toolbarNote}>Result set shown</span>}
        </div>
        <div className={styles.mapCell}>
          <BoreholeMap
            pins={pins}
            highlightUid={reviewUid}
            focus={mapFocus}
            view={mapView}
            selectedUid={selectedUid}
            legendRef={legendRef}
            onOpen={openBorehole}
            onViewChange={setMapView}
            onSelect={selectOnMap}
          />
          <MapLegend ref={legendRef} entries={legend} />
          {rows.length === 0 && <EmptyMapOverlay onOpenQueue={() => go('queue')} />}
        </div>
        <div className={styles.bottom}>
          <ResultsTable
            rows={tableRows}
            selectedUid={selectedUid}
            resetKey={resultSet?.id ?? 'all'}
            empty={resultSet ? 'No borehole of this result set is loaded.' : undefined}
            extra={<ResultSetSummary resultSet={resultSet} busy={resultSetBusy} error={resultSetError} onClear={clearResultSet} />}
            onOpen={openBorehole}
            onShow={selectOnMap}
          />
          <NotOnMapList boreholes={notOnMap} total={rows.length} onOpen={openBorehole} />
        </div>
      </div>
    </div>
  );
}
