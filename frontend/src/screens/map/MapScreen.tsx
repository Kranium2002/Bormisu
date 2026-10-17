/**
 * Map screen (prototype template lines 48–79): Leaflet map with status-coloured pins and the
 * REVIEW STATUS legend, the NOT ON MAP aside, and the RESULTS table underneath. Pins and rows come
 * from the light map features of the plotted boreholes; NOT ON MAP lists the full records of the
 * unplotted ones (both loaded at boot). Before anything is uploaded the map keeps its world view and
 * says how to get boreholes onto it.
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
import { legendEntries, mapRows } from './mapModel';
import styles from './MapScreen.module.css';
import { NotOnMapList } from './NotOnMapList';
import { ResultsTable } from './ResultsTable';

export function MapScreen() {
  const features = useAppStore((s) => s.features);
  const boreholes = useAppStore((s) => s.boreholes);
  const unplottedUids = useAppStore((s) => s.unplottedUids);
  const reviewUid = useAppStore((s) => s.reviewUid);
  const mapFocus = useAppStore((s) => s.mapFocus);
  const mapView = useAppStore((s) => s.mapView);
  const selectedUid = useAppStore((s) => s.selectedUid);
  const openBorehole = useAppStore((s) => s.openBorehole);
  const setMapView = useAppStore((s) => s.setMapView);
  const selectOnMap = useAppStore((s) => s.selectOnMap);
  const go = useAppStore((s) => s.go);
  const legendRef = useRef<HTMLDivElement>(null);

  const { rows, pins, notOnMap } = useMemo(() => mapRows(features, boreholes, unplottedUids), [features, boreholes, unplottedUids]);
  const legend = useMemo(() => legendEntries(pins), [pins]);

  return (
    <div className={styles.screen} data-screen-label="Map">
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
      <NotOnMapList boreholes={notOnMap} total={rows.length} onOpen={openBorehole} />
      <ResultsTable rows={rows} onOpen={openBorehole} />
    </div>
  );
}
