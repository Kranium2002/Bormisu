/**
 * List screen: every borehole in one table, the ones on the map first, then those the map can't place
 * (NOT ON MAP with the reason in their STATUS). A search for a borehole without coordinates lands here and
 * highlights its row while the search message shows.
 */
import { useMemo } from 'react';
import { WORLD } from '../../geo/mapFocus';
import { matchesQuery } from '../../domain/search';
import { useAppStore } from '../../store/appStore';
import styles from './ListScreen.module.css';
import { notOnMapSearchTarget, placeBoreholes, statusByUid } from './mapModel';
import { ResultsTable } from './ResultsTable';

export function ListScreen() {
  const boreholes = useAppStore((s) => s.boreholes);
  const searchMessage = useAppStore((s) => s.searchMessage);
  const query = useAppStore((s) => s.query);
  const openBorehole = useAppStore((s) => s.openBorehole);

  const statuses = useMemo(() => statusByUid(boreholes), [boreholes]);
  const placement = useMemo(() => placeBoreholes(boreholes, WORLD, null), [boreholes]);
  // While typing in the search box, only the matching rows stay.
  const rows = useMemo(
    () => [...placement.plotted, ...placement.unplaced.map((u) => u.borehole)].filter((b) => matchesQuery(b, query)),
    [placement, query],
  );
  const notOnMap = useMemo(() => new Map(placement.unplaced.map((u) => [u.borehole.uid, u.reason])), [placement]);
  const activeUid = notOnMapSearchTarget(searchMessage, placement.unplaced, null);

  return (
    <div className={styles.screen} data-screen-label="List">
      <ResultsTable
        boreholes={rows}
        statuses={statuses}
        notOnMap={notOnMap}
        activeUid={activeUid}
        anyBoreholes={boreholes.length > 0}
        onOpen={openBorehole}
      />
    </div>
  );
}
