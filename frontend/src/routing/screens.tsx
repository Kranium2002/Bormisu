/**
 * Route elements: each shows its screen once the store shows the route (RouteSync applies it before
 * the paint), "not found" for a uid the store doesn't have, and never a blank screen. While the data
 * loads, App shows the loading state instead of any of these.
 */
import { Navigate, useRouteError } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { DetailScreen } from '../screens/detail/DetailScreen';
import { InboxScreen } from '../screens/inbox/InboxScreen';
import { useInboxQuery } from '../screens/inbox/useInboxQuery';
import { MapScreen } from '../screens/map/MapScreen';
import { QueueScreen } from '../screens/queue/QueueScreen';
import { ReviewScreen } from '../screens/review/ReviewScreen';
import { useAppStore, useBorehole } from '../store/appStore';
import { reviewHref } from './navLinks';
import { NotFound } from './NotFound';
import { useLocationRoute } from './RouteSync';
import { routeUid, sameScreen } from './urlState';

const BOREHOLE_NOT_FOUND = 'BOREHOLE NOT FOUND';
const BOREHOLE_NOT_FOUND_TEXT = 'No loaded borehole has the ID in this link. It may have been deleted, or the link is incomplete.';

/** True once the store shows the screen of the current location (and its borehole). */
function useShown(): boolean {
  const route = useLocationRoute();
  return useAppStore(
    (s) =>
      sameScreen(s.route, route) &&
      (route.kind !== 'review' || s.reviewUid === route.uid) &&
      (route.kind !== 'detail' || s.selectedUid === route.uid),
  );
}

export function MapRoute() {
  return useShown() ? <MapScreen /> : null;
}

export function QueueRoute() {
  return <QueueScreen />;
}

/** /review: the review target (with history replace), else "nothing to review". */
export function ReviewIndexRoute() {
  const to = useAppStore(reviewHref);
  return to ? <Navigate to={to} replace /> : <ReviewScreen />;
}

/**
 * A borehole route whose record isn't cached: RouteSync fetches it on demand. LOADING while it is
 * fetched (or not asked for yet), BOREHOLE NOT FOUND only when the server has no such borehole, and
 * an error state when the request failed.
 */
function MissingRecord({ uid }: { uid: string | null }) {
  const load = useAppStore((s) => (uid ? s.recordLoads[uid] : undefined));
  if (!uid || load === 'missing') return <NotFound title={BOREHOLE_NOT_FOUND} message={BOREHOLE_NOT_FOUND_TEXT} />;
  if (load === 'error') {
    return <EmptyState tone="error" title="NOT LOADED" message="The borehole could not be loaded. Check the connection and reload the page." />;
  }
  return <EmptyState title="LOADING" message="Loading the borehole…" />;
}

export function ReviewRoute() {
  const uid = routeUid(useLocationRoute());
  const borehole = useBorehole(uid);
  const shown = useShown();
  if (!borehole) return <MissingRecord uid={uid} />;
  return shown ? <ReviewScreen /> : null;
}

export function BoreholeRoute() {
  const uid = routeUid(useLocationRoute());
  const borehole = useBorehole(uid);
  const shown = useShown();
  if (!borehole) return <MissingRecord uid={uid} />;
  return shown ? <DetailScreen /> : null;
}

/** /inbox: the questions; ?q= opens one in the dialog, and the open dialog writes ?q= (history replace). */
export function InboxRoute() {
  const route = useLocationRoute();
  const { notOpen } = useInboxQuery(route.kind === 'inbox' ? route.q : null);
  return <InboxScreen notOpen={notOpen} />;
}

export function NotFoundRoute() {
  return <NotFound title="PAGE NOT FOUND" message="There is no page at this address." />;
}

/** A screen that failed to render: the error instead of a blank page. */
export function RouteError() {
  const error = useRouteError();
  const text = error instanceof Error ? error.message : 'Something went wrong while showing this page.';
  return (
    <EmptyState
      tone="error"
      title="THIS PAGE FAILED"
      message={text}
      action={{ label: 'RELOAD', onClick: () => window.location.reload() }}
    />
  );
}
