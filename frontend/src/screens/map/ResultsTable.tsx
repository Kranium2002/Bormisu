import type { MouseEvent } from 'react';
import { StatusChip } from '../../components/StatusChip';
import type { Borehole, BoreholeStatus } from '../../domain/types';
import { crsCell, depthText, resultsSummary, type OutsideSummary } from './mapModel';
import styles from './ResultsTable.module.css';

interface Props {
  /** The rows: the focus' boreholes plus those without coordinates. */
  boreholes: Borehole[];
  statuses: Map<string, BoreholeStatus>;
  /** "World" or the focus country's name, shown in the title. */
  focusLabel: string;
  /** False when there is no borehole at all (then the empty row points to the upload). */
  anyBoreholes: boolean;
  /** The country outlines are still loading. */
  loading: boolean;
  /** Boreholes outside the focus country, shown as a footer with SHOW WORLD. */
  outside: OutsideSummary | null;
  onOpen(uid: string): void;
  onShowWorld(): void;
}

const COLUMNS = ['BOREHOLE', 'PROJECT', 'FINAL DEPTH', 'STATUS', 'CRS'] as const;

/**
 * RESULTS table under the map: the boreholes of the map focus with project, final depth, review status
 * and CRS status. Every row opens the borehole's detail, also for boreholes not on the map: those are
 * the ones whose coordinates need a look. A click anywhere on the row opens it; for the keyboard and
 * screen readers each row has an OPEN DETAIL › button.
 */
export function ResultsTable({ boreholes, statuses, focusLabel, anyBoreholes, loading, outside, onOpen, onShowWorld }: Props) {
  const empty = loading
    ? 'Loading country outlines…'
    : anyBoreholes
      ? `No boreholes in ${focusLabel}.`
      : 'No boreholes yet. Upload a report under UPLOAD & QUEUE.';
  return (
    <section className={styles.results} aria-labelledby="results-title">
      <div className={styles.head}>
        <h2 id="results-title" className={styles.title}>
          RESULTS <span className={styles.focus}>· {focusLabel.toUpperCase()}</span>
        </h2>
        <div className={styles.summary}>{resultsSummary(boreholes)}</div>
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
        {boreholes.length === 0 && (
          <div className={styles.empty} role="row">
            <div role="cell">{empty}</div>
          </div>
        )}
        {boreholes.map((b) => (
          <ResultRow key={b.uid} borehole={b} status={statuses.get(b.uid) ?? 'unreviewed'} onOpen={onOpen} />
        ))}
      </div>
      {outside && (
        <div className={styles.footer} data-testid="results-outside">
          <span>{outside.text}</span>
          <span className={styles.footerDetail}>{outside.detail}</span>
          <button type="button" className={styles.showWorld} onClick={onShowWorld}>
            SHOW WORLD ›
          </button>
        </div>
      )}
    </section>
  );
}

function ResultRow({ borehole: b, status, onOpen }: { borehole: Borehole; status: BoreholeStatus; onOpen(uid: string): void }) {
  const crs = crsCell(b.crs);
  const onButton = (e: MouseEvent) => {
    // The row's own click would open the detail a second time.
    e.stopPropagation();
    onOpen(b.uid);
  };
  return (
    <div className={`${styles.row} ${styles.body} ${styles.clickable}`} role="row" data-uid={b.uid} onClick={() => onOpen(b.uid)}>
      <div className={`${styles.cell} ${styles.id}`} role="cell">
        {b.id}
      </div>
      <div className={styles.cell} role="cell">
        {b.project}
      </div>
      <div className={`${styles.cell} ${styles.mono}`} role="cell">
        {depthText(b)}
      </div>
      <div className={styles.cell} role="cell">
        <StatusChip status={status} />
      </div>
      <div className={`${styles.cell} ${crs.warn ? styles.warn : styles.muted}`} role="cell" title={crs.title}>
        {crs.text}
      </div>
      <div className={`${styles.cell} ${styles.actionCell}`} role="cell">
        <button type="button" className={styles.action} aria-label={`Open detail of ${b.id}`} onClick={onButton}>
          OPEN DETAIL ›
        </button>
      </div>
    </div>
  );
}
