/**
 * Map screen (prototype template lines 48–79): Leaflet map with status-coloured pins and the
 * REVIEW STATUS legend, the NOT ON MAP aside, and the RESULTS table underneath. Before anything is
 * uploaded the map keeps its world view and says how to get boreholes onto it.
 *
 * The map's URL state (/map?at=lat,lng,zoom&sel=uid) comes from the store, which follows the URL:
 * pan and zoom write `at`, an opened popup writes `sel` (history replace), and a reload or Back
 * restores both.
 */
import { useMemo, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { BoreholeMap } from './BoreholeMap';
import { EmptyMapOverlay } from './EmptyMapOverlay';
import { MapLegend } from './MapLegend';
import { isPlotted, legendEntries, statusByUid } from './mapModel';
import styles from './MapScreen.module.css';
import { NotOnMapList } from './NotOnMapList';
import { ResultsTable } from './ResultsTable';

export function MapScreen() {
  const boreholes = useAppStore((s) => s.boreholes);
  const reviewUid = useAppStore((s) => s.reviewUid);
  const mapFocus = useAppStore((s) => s.mapFocus);
  const mapView = useAppStore((s) => s.mapView);
  const selectedUid = useAppStore((s) => s.selectedUid);
  const openBorehole = useAppStore((s) => s.openBorehole);
  const setMapView = useAppStore((s) => s.setMapView);
  const selectOnMap = useAppStore((s) => s.selectOnMap);
  const go = useAppStore((s) => s.go);
  const legendRef = useRef<HTMLDivElement>(null);

  const statuses = useMemo(() => statusByUid(boreholes), [boreholes]);
  const legend = useMemo(() => legendEntries(boreholes, statuses), [boreholes, statuses]);
  const notOnMap = useMemo(() => boreholes.filter((b) => !isPlotted(b)), [boreholes]);

  return (
    <div className={styles.screen} data-screen-label="Map">
      <div className={styles.mapCell}>
        <BoreholeMap
          boreholes={boreholes}
          statuses={statuses}
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
        {boreholes.length === 0 && <EmptyMapOverlay onOpenQueue={() => go('queue')} />}
      </div>
      <NotOnMapList boreholes={notOnMap} total={boreholes.length} onOpen={openBorehole} />
      <ResultsTable boreholes={boreholes} statuses={statuses} onOpen={openBorehole} />
    </div>
  );
}
