/**
 * The active result set in one line (FRONTEND.md F10): "N boreholes · M on the map · K not located ·
 * X unreviewed left out", from the server's counts, announced politely; a request in flight (filters,
 * an area drawn on the map, a link) shows busy, a failure the server's detail as an alert. CLEAR drops
 * the set (and the filters), like RESET in the filter panel. The set's id is in the URL (?rs=), so a
 * reload or a link shows the same set.
 *
 * `compact` (the chip over the map) shows only "N boreholes" on screen; the rest of the line stays in
 * the text screen readers hear. `extra` goes before CLEAR (the map's OPEN LIST ›).
 */
import type { ReactNode } from 'react';
import type { ResultSet } from '../../../domain/types';
import { useT } from '../../../i18n';
import { resultSetSummary } from './resultsModel';
import styles from './ResultSetSummary.module.css';

export interface ResultSetSummaryProps {
  resultSet: Pick<ResultSet, 'id' | 'count' | 'locatedCount' | 'unlocatedCount' | 'excludedUnreviewed'> | null;
  busy: boolean;
  error: string | null;
  onClear(): void;
  compact?: boolean;
  extra?: ReactNode;
}

export function ResultSetSummary({ resultSet, busy, error, onClear, compact = false, extra }: ResultSetSummaryProps) {
  const t = useT();
  const active = !!resultSet || busy || !!error;
  const text = resultSet ? resultSetSummary(resultSet) : '';
  const cut = compact ? text.indexOf(' · ') : -1;
  return (
    <div
      className={`${styles.bar} ${active ? styles.active : ''} ${compact ? styles.compact : ''}`}
      aria-busy={busy}
      data-result-set-bar=""
      data-result-set={resultSet?.id}
    >
      {resultSet && <span className={styles.tag}>{t(compact ? 'FILTERED' : 'RESULT SET')}</span>}
      {/* Always rendered, so a new set's counts are announced. */}
      <p className={styles.summary} aria-live="polite" aria-atomic="true">
        {busy ? (
          t('Selecting boreholes…')
        ) : cut > 0 ? (
          <>
            {text.slice(0, cut)}
            <span className={styles.rest}>{text.slice(cut)}</span>
          </>
        ) : (
          text
        )}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {resultSet && extra}
      {resultSet && (
        <button type="button" className={styles.clear} onClick={onClear} aria-label="Clear the result set and the filters">
          {t('CLEAR')}
        </button>
      )}
    </div>
  );
}
