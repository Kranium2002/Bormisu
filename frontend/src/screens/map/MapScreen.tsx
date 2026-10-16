/**
 * Map screen (prototype template lines 48–79): Leaflet map with status-coloured pins and the
 * REVIEW STATUS legend, the NOT ON MAP aside, and the RESULTS table underneath.
 */
import { useMemo } from 'react';
import { useAppStore } from '../../store/appStore';
import { BoreholeMap } from './BoreholeMap';
import { MapLegend } from './MapLegend';
import { isPlotted, legendEntries, statusByUid } from './mapModel';
import styles from './MapScreen.module.css';
import { NotOnMapList } from './NotOnMapList';
import { ResultsTable } from './ResultsTable';

export function MapScreen() {
  const boreholes = useAppStore((s) => s.boreholes);
  const reviewUid = useAppStore((s) => s.reviewUid);
  const mapFocus = useAppStore((s) => s.mapFocus);
  const openBorehole = useAppStore((s) => s.openBorehole);

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
          onOpen={openBorehole}
        />
        <MapLegend entries={legend} />
      </div>
      <NotOnMapList boreholes={notOnMap} onOpen={openBorehole} />
      <ResultsTable boreholes={boreholes} statuses={statuses} onOpen={openBorehole} />
    </div>
  );
}
