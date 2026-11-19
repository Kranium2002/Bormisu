/**
 * The entry points of the 3D view (3D VIEW). Light on purpose: deck.gl and the screen itself load
 * only when /3d is opened (src/routing/screens.tsx), so nothing here imports them.
 */
import type { Alignment, AlignmentResult } from '../domain/types';
import { lineUrlState, SelectionButton, selectionUrlState, type SelectionButtonProps } from '../report/ReportButton';
import { view3dPath } from '../routing/urlState';
import type { AppState } from '../store/types';

export const VIEW_3D = '3D VIEW';

/** /3d of a planned line's hits (queried again with the same distance and scope on a reload). */
export function lineView3dPath(alignment: Pick<Alignment, 'id'>, result: Pick<AlignmentResult, 'bufferM' | 'includeUnreviewed' | 'resultSet'>): string {
  return view3dPath(lineUrlState(alignment, result));
}

/** /3d of what is selected (the planned line's hits, else the active result set); null without a selection. */
export function selectionView3dPath(s: Pick<AppState, 'resultSet' | 'alignment' | 'alignmentResult'>): string | null {
  const u = selectionUrlState(s);
  return u && view3dPath(u);
}

/** 3D VIEW: opens the selection's boreholes in 3D below the map (like EXPORT REPORT opens its report). */
export function View3DButton(props: SelectionButtonProps) {
  return <SelectionButton {...props} kind="view3d" label={VIEW_3D} testId="view-3d" failure="The 3D view could not be opened" />;
}
