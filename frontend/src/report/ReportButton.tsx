import { useState } from 'react';
import { Link } from 'react-router';
import { errorText } from '../data/errors';
import type { Alignment, AlignmentResult, Area } from '../domain/types';
import { useT } from '../i18n';
import { reportPath, routePath, type ReportUrlState } from '../routing/urlState';
import { useAppStore } from '../store/appStore';
import { EMPTY_FILTER } from '../store/mapDataSlice';
import type { AppState } from '../store/types';

export const EXPORT_REPORT = 'EXPORT REPORT';

/** A planned line's hits as a selection URL (queried again with the same distance and scope on a reload). */
export function lineUrlState(alignment: Pick<Alignment, 'id'>, result: Pick<AlignmentResult, 'bufferM' | 'includeUnreviewed' | 'resultSet'>): ReportUrlState {
  return { rs: result.resultSet.id, line: alignment.id, buffer: result.bufferM, unrev: result.includeUnreviewed };
}

/**
 * What is selected as a selection URL: the planned line's hits while its result set is the active one,
 * else the active result set (an area, a search, the filters); null without a selection.
 */
export function selectionUrlState(s: Pick<AppState, 'resultSet' | 'alignment' | 'alignmentResult'>): ReportUrlState | null {
  if (!s.resultSet) return null;
  const r = s.alignmentResult;
  if (r && s.alignment && r.resultSet.id === s.resultSet.id) return lineUrlState(s.alignment, r);
  return { rs: s.resultSet.id, line: null, buffer: null, unrev: null };
}

/** /report of a planned line's hits (queried again with the same distance and scope on a reload). */
export function lineReportPath(alignment: Pick<Alignment, 'id'>, result: Pick<AlignmentResult, 'bufferM' | 'includeUnreviewed' | 'resultSet'>): string {
  return reportPath(lineUrlState(alignment, result));
}

/** /report of what is selected (see selectionUrlState); null without a selection. */
export function selectionReportPath(s: Pick<AppState, 'resultSet' | 'alignment' | 'alignmentResult'>): string | null {
  const u = selectionUrlState(s);
  return u && reportPath(u);
}

export interface SelectionButtonProps {
  className?: string;
  /**
   * `selection`: only while something is selected. `list`: in LIST, also without a selection, for the
   * boreholes listed (all of them, or those the header search keeps). `map`: on the map, also without a
   * selection, for the boreholes the map shows (`area`).
   */
  scope: 'selection' | 'list' | 'map';
  /** The header search, for `list` and `map`. */
  query?: string;
  /** What the map shows right now, for `map`; null (or absent) takes every borehole. */
  area?(): Area | null;
}

interface Target {
  /** The screen it opens; it reads the selection from its URL. */
  kind: 'report' | 'view3d';
  /** The button's text (an English key). */
  label: string;
  testId: string;
  /** The toast's text when the listed boreholes could not become a result set (an English key). */
  failure: string;
}

/**
 * A button that opens a screen of the selection (the report, the 3D view): a link while something is
 * selected; without a selection, in LIST the listed boreholes and on the map the boreholes it shows
 * first become a result set (it is not made the map's selection).
 */
export function SelectionButton({ className, scope, query, area, kind, label, testId, failure }: SelectionButtonProps & Target) {
  const t = useT();
  const to = useAppStore((s) => {
    const u = selectionUrlState(s);
    return u && routePath({ kind, ...u });
  });
  const [busy, setBusy] = useState(false);
  if (to) {
    return (
      <Link className={className} to={to} data-testid={testId}>
        {t(label)}
      </Link>
    );
  }
  if (scope === 'selection') return null;
  // No selection: the listed boreholes (LIST) or those the map shows become a result set, so the screen
  // has a link of its own.
  const open = async () => {
    const s = useAppStore.getState();
    if (!s.source) return;
    setBusy(true);
    try {
      const search = query?.trim() || null;
      const shown = scope === 'map' ? (area?.() ?? null) : null;
      const rs = await s.source.createResultSet({ ...EMPTY_FILTER, dinCodes: [], reviewStatus: [], search, area: shown });
      s.showRoute({ kind, rs: rs.id, line: null, buffer: null, unrev: null });
    } catch (e) {
      s.showToast(`${t(failure)}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={className} disabled={busy} aria-busy={busy} onClick={() => void open()} data-testid={testId}>
      {t(label)}
    </button>
  );
}

/** EXPORT REPORT: opens the printable report of the selection. */
export function ReportButton(props: SelectionButtonProps) {
  return <SelectionButton {...props} kind="report" label={EXPORT_REPORT} testId="export-report" failure="The report could not be opened" />;
}
