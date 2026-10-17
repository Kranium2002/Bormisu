/**
 * The active result set in one line above the RESULTS table (FRONTEND.md F10): "N boreholes · M on
 * the map · K not located · X unreviewed left out", from the server's counts, announced politely; a
 * request in flight (filters, an area drawn on the map, a link) shows busy, a failure the server's
 * detail as an alert. CLEAR drops the set (and the filters), like RESET in the filter panel. The
 * set's id is in the URL (?rs=), so a reload or a link shows the same set.
 */
import type { ResultSet } from '../../../domain/types';
import { resultSetSummary } from './resultsModel';
import styles from './ResultSetSummary.module.css';

export interface ResultSetSummaryProps {
  resultSet: Pick<ResultSet, 'id' | 'count' | 'locatedCount' | 'unlocatedCount' | 'excludedUnreviewed'> | null;
  busy: boolean;
  error: string | null;
  onClear(): void;
}

export function ResultSetSummary({ resultSet, busy, error, onClear }: ResultSetSummaryProps) {
  const active = !!resultSet || busy || !!error;
  return (
    <div className={`${styles.bar} ${active ? styles.active : ''}`} aria-busy={busy} data-result-set-bar="" data-result-set={resultSet?.id}>
      {resultSet && <span className={styles.tag}>RESULT SET</span>}
      {/* Always rendered, so a new set's counts are announced. */}
      <p className={styles.summary} aria-live="polite" aria-atomic="true">
        {busy ? 'Selecting boreholes…' : resultSet ? resultSetSummary(resultSet) : ''}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {resultSet && (
        <button type="button" className={styles.clear} onClick={onClear} aria-label="Clear the result set and the filters">
          CLEAR
        </button>
      )}
    </div>
  );
}
