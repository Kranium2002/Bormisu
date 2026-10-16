/**
 * Map screen (prototype template lines 48–79): Leaflet map with status-coloured pins and the
 * REVIEW STATUS legend, the NOT ON MAP aside, and the RESULTS table underneath.
 *
 * The map focus (VITE_MAP_FOCUS, default DE) restricts the map to Germany: boreholes outside it move
 * from the map to NOT ON MAP, and the legend counts only the pins drawn. RESULTS lists every borehole.
 */
import { useMemo } from 'react';
import { FOCUS_REGION } from '../../geo/mapFocus';
import { useAppStore } from '../../store/appStore';
import { BoreholeMap } from './BoreholeMap';
import { MapLegend } from './MapLegend';
import { legendEntries, placeBoreholes, statusByUid } from './mapModel';
import styles from './MapScreen.module.css';
import { NotOnMapList } from './NotOnMapList';
import { ResultsTable } from './ResultsTable';

export function MapScreen() {
  const boreholes = useAppStore((s) => s.boreholes);
  const reviewUid = useAppStore((s) => s.reviewUid);
  const mapFocus = useAppStore((s) => s.mapFocus);
  const openBorehole = useAppStore((s) => s.openBorehole);
  const showNotOnMap = useAppStore((s) => s.showNotOnMap);

  const statuses = useMemo(() => statusByUid(boreholes), [boreholes]);
  const placement = useMemo(() => placeBoreholes(boreholes, FOCUS_REGION), [boreholes]);
  const legend = useMemo(() => legendEntries(placement.plotted, statuses), [placement, statuses]);

  /** A search target the map doesn't draw (e.g. outside the focus): explain it instead of flying. */
  const onFocusMissed = (uid: string) => {
    const item = placement.notOnMap.find((i) => i.borehole.uid === uid);
    if (item) showNotOnMap(item.borehole.id, item.reason.text);
  };

  return (
    <div className={styles.screen} data-screen-label="Map">
      <div className={styles.mapCell}>
        <BoreholeMap
          boreholes={placement.plotted}
          statuses={statuses}
          highlightUid={reviewUid}
          focus={mapFocus}
          region={FOCUS_REGION}
          onOpen={openBorehole}
          onFocusMissed={onFocusMissed}
        />
        <MapLegend entries={legend} />
      </div>
      <NotOnMapList
        items={placement.notOnMap}
        outsideRegion={placement.outsideFocus > 0 && FOCUS_REGION ? FOCUS_REGION.name : null}
        onOpen={openBorehole}
      />
      <ResultsTable boreholes={boreholes} statuses={statuses} onOpen={openBorehole} />
    </div>
  );
}
