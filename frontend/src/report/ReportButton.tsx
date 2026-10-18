import { useState } from 'react';
import { Link } from 'react-router';
import { errorText } from '../data/errors';
import type { Alignment, AlignmentResult } from '../domain/types';
import { useT } from '../i18n';
import { reportPath } from '../routing/urlState';
import { useAppStore } from '../store/appStore';
import { EMPTY_FILTER } from '../store/mapDataSlice';
import type { AppState } from '../store/types';

export const EXPORT_REPORT = 'EXPORT REPORT';

/** /report of a planned line's hits (queried again with the same distance and scope on a reload). */
export function lineReportPath(alignment: Pick<Alignment, 'id'>, result: Pick<AlignmentResult, 'bufferM' | 'includeUnreviewed' | 'resultSet'>): string {
  return reportPath({ rs: result.resultSet.id, line: alignment.id, buffer: result.bufferM, unrev: result.includeUnreviewed });
}

/**
 * /report of what is selected: the planned line's hits while its result set is the active one, else
 * the active result set (an area, a search, the filters); null without a selection.
 */
export function selectionReportPath(s: Pick<AppState, 'resultSet' | 'alignment' | 'alignmentResult'>): string | null {
  if (!s.resultSet) return null;
  const r = s.alignmentResult;
  if (r && s.alignment && r.resultSet.id === s.resultSet.id) return lineReportPath(s.alignment, r);
  return reportPath({ rs: s.resultSet.id });
}

interface Props {
  className?: string;
  /**
   * `selection`: only while something is selected. `list`: in LIST, also without a selection, for the
   * boreholes listed (all of them, or those the header search keeps).
   */
  scope: 'selection' | 'list';
  /** LIST's header search, for `list`. */
  query?: string;
}

/** EXPORT REPORT: opens the printable report of the selection. */
export function ReportButton({ className, scope, query }: Props) {
  const t = useT();
  const to = useAppStore(selectionReportPath);
  const [busy, setBusy] = useState(false);
  if (to) {
    return (
      <Link className={className} to={to} data-testid="export-report">
        {t(EXPORT_REPORT)}
      </Link>
    );
  }
  if (scope !== 'list') return null;
  // LIST without a selection: the listed boreholes become a result set, so the report has a link of its own.
  const open = async () => {
    const s = useAppStore.getState();
    if (!s.source) return;
    setBusy(true);
    try {
      const search = query?.trim() || null;
      const rs = await s.source.createResultSet({ ...EMPTY_FILTER, dinCodes: [], reviewStatus: [], search });
      s.showRoute({ kind: 'report', rs: rs.id, line: null, buffer: null, unrev: null });
    } catch (e) {
      s.showToast(`${t('The report could not be opened')}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={className} disabled={busy} aria-busy={busy} onClick={() => void open()} data-testid="export-report">
      {t(EXPORT_REPORT)}
    </button>
  );
}
