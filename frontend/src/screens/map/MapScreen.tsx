/**
 * Map screen: the whole world with status-coloured pins and the REVIEW STATUS legend. A search result
 * flies there. The table of all boreholes (also those not on the map) is the LIST screen.
 */
import { useMemo } from 'react';
import { WORLD } from '../../geo/mapFocus';
import { boxOf } from '../../geo/polygon';
import { matchesQuery } from '../../domain/search';
import { useAppStore } from '../../store/appStore';
import { BoreholeMap, type MapView } from './BoreholeMap';
import { MapLegend } from './MapLegend';
import { isPlotted, legendEntries, statusByUid } from './mapModel';
import styles from './MapScreen.module.css';

export function MapScreen() {
  const boreholes = useAppStore((s) => s.boreholes);
  const reviewUid = useAppStore((s) => s.reviewUid);
  const flyTarget = useAppStore((s) => s.flyTarget);
  const query = useAppStore((s) => s.query);
  const openBorehole = useAppStore((s) => s.openBorehole);

  const statuses = useMemo(() => statusByUid(boreholes), [boreholes]);
  const allPins = useMemo(() => boreholes.filter(isPlotted), [boreholes]);
  // While typing in the search box, only the matching pins stay, drawn larger.
  const pins = useMemo(() => allPins.filter((b) => matchesQuery(b, query)), [allPins, query]);
  const filtering = pins.length < allPins.length;
  const highlight = useMemo(() => new Set(filtering ? pins.map((b) => b.uid) : reviewUid ? [reviewUid] : []), [filtering, pins, reviewUid]);
  const legend = useMemo(() => legendEntries(pins, statuses), [pins, statuses]);
  const view = useMemo<MapView>(() => ({ kind: 'world', key: WORLD, pins: boxOf(allPins) }), [allPins]);
  // Only pins can be flown to; the store sends a search for a borehole without coordinates to LIST.
  const fly = flyTarget && pins.some((b) => b.uid === flyTarget.uid) ? flyTarget : null;

  return (
    <div className={styles.screen} data-screen-label="Map">
      <BoreholeMap
        boreholes={pins}
        statuses={statuses}
        highlightUids={highlight}
        view={view}
        fly={fly}
        closePopupNonce={0}
        me={null}
        flyToMe={false}
        meOffsetPx={0}
        locateControl={null}
        onOpen={openBorehole}
      />
      <MapLegend entries={legend} />
    </div>
  );
}
