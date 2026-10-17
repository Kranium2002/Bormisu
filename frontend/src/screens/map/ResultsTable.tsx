import type { KeyboardEvent } from 'react';
import { StatusChip } from '../../components/StatusChip';
import { crsCell, depthText, resultsSummary, type MapRow } from './mapModel';
import styles from './ResultsTable.module.css';

interface Props {
  /** Plotted boreholes and the ones not on the map (mapRows). */
  rows: MapRow[];
  onOpen(uid: string): void;
}

const COLUMNS = ['BOREHOLE', 'PROJECT', 'FINAL DEPTH', 'STATUS', 'CRS'] as const;

/**
 * RESULTS table under the map: every borehole with project, final depth, review status and CRS status.
 * Every row opens the borehole's detail (click, Enter or Space), also for boreholes not on the map:
 * those are the ones whose coordinates need a look.
 */
export function ResultsTable({ rows, onOpen }: Props) {
  return (
    <section className={styles.results} aria-labelledby="results-title">
      <div className={styles.head}>
        <h2 id="results-title" className={styles.title}>
          RESULTS
        </h2>
        {/* The count changes as documents finish extraction: screen readers hear it (FRONTEND.md section 6). */}
        <div className={styles.summary} aria-live="polite">
          {resultsSummary(rows)}
        </div>
      </div>
      <div className={styles.scroll} role="table" aria-labelledby="results-title">
        <div className={`${styles.row} ${styles.header}`} role="row">
          {COLUMNS.map((c) => (
            <div key={c} className={styles.cell} role="columnheader">
              {c}
            </div>
          ))}
          <div className={styles.cell} role="columnheader" aria-label="Action" />
        </div>
        {rows.length === 0 && (
          <div className={styles.empty} role="row">
            <div role="cell">No boreholes yet. Upload a report under UPLOAD &amp; QUEUE.</div>
          </div>
        )}
        {rows.map((r) => (
          <ResultRow key={r.uid} row={r} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function ResultRow({ row: b, onOpen }: { row: MapRow; onOpen(uid: string): void }) {
  const crs = crsCell(b.crs);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(b.uid);
    }
  };
  return (
    <div
      className={`${styles.row} ${styles.body} ${styles.clickable}`}
      role="row"
      data-uid={b.uid}
      tabIndex={0}
      onClick={() => onOpen(b.uid)}
      onKeyDown={onKeyDown}
    >
      <div className={`${styles.cell} ${styles.id}`} role="cell">
        {b.id}
      </div>
      <div className={styles.cell} role="cell">
        {b.project}
      </div>
      <div className={`${styles.cell} ${styles.mono}`} role="cell">
        {depthText(b.depth)}
      </div>
      <div className={styles.cell} role="cell">
        <StatusChip status={b.status} />
      </div>
      <div className={`${styles.cell} ${crs.warn ? styles.warn : styles.muted}`} role="cell" title={crs.title}>
        {crs.text}
      </div>
      <div className={`${styles.cell} ${styles.action}`} role="cell">
        OPEN DETAIL ›
      </div>
    </div>
  );
}
