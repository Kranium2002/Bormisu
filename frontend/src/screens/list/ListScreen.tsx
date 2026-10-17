/**
 * LIST (/list): every borehole the map knows as a table, or the active result set's members (the
 * filters and the area of the map apply here too), and the boreholes that are not on the map with
 * their reason. MAP in a row shows the borehole on the map; a row opens its detail.
 */
import { useMemo } from 'react';
import { useAppStore } from '../../store/appStore';
import { ResultSetSummary } from '../map/explore/ResultSetSummary';
import { allRows, resultSetRows } from '../map/explore/resultsModel';
import { mapRows } from '../map/mapModel';
import { NotOnMapList } from '../map/NotOnMapList';
import { ResultsTable } from '../map/ResultsTable';
import styles from './ListScreen.module.css';

/** Empty table while a result set is active: it has no member, or none the app holds (deleted meanwhile). */
const NO_MATCH = 'No borehole matches this selection.';
const NOT_LOADED = 'No borehole of this result set is loaded.';

export function ListScreen() {
  const features = useAppStore((s) => s.features);
  const boreholes = useAppStore((s) => s.boreholes);
  const unplottedUids = useAppStore((s) => s.unplottedUids);
  const documents = useAppStore((s) => s.documents);
  const selectedUid = useAppStore((s) => s.selectedUid);
  const resultSet = useAppStore((s) => s.resultSet);
  const resultSetFeatures = useAppStore((s) => s.resultSetFeatures);
  const resultSetBusy = useAppStore((s) => s.resultSetBusy);
  const resultSetError = useAppStore((s) => s.resultSetError);
  const openBorehole = useAppStore((s) => s.openBorehole);
  const showOnMap = useAppStore((s) => s.focusChatBorehole);
  const clearResultSet = useAppStore((s) => s.clearResultSet);

  const { rows, notOnMap } = useMemo(() => mapRows(features, boreholes, unplottedUids), [features, boreholes, unplottedUids]);
  const tableRows = useMemo(
    () =>
      resultSet && resultSetFeatures
        ? resultSetRows(resultSet, resultSetFeatures, features, boreholes, documents)
        : allRows(features, boreholes, unplottedUids, documents),
    [resultSet, resultSetFeatures, features, boreholes, unplottedUids, documents],
  );

  return (
    <div className={styles.screen} data-screen-label="List">
      <ResultsTable
        rows={tableRows}
        selectedUid={selectedUid}
        resetKey={resultSet?.id ?? 'all'}
        empty={resultSet ? (resultSet.count === 0 ? NO_MATCH : NOT_LOADED) : undefined}
        extra={<ResultSetSummary resultSet={resultSet} busy={resultSetBusy} error={resultSetError} onClear={clearResultSet} />}
        onOpen={openBorehole}
        onShow={showOnMap}
      />
      <NotOnMapList boreholes={notOnMap} total={rows.length} onOpen={openBorehole} />
    </div>
  );
}
