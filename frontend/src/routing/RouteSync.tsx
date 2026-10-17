/**
 * The route sync: applies every location the router reports to the store (applyRoute), one way,
 * URL → store. It runs once the data is loaded (a deep link waits for the boreholes it names) and
 * again when the borehole of the route appears or goes. A layout effect, so a screen never paints
 * with the previous route's selection.
 */
import { useLayoutEffect, useMemo } from 'react';
import { useLocation } from 'react-router';
import { useAppStore } from '../store/appStore';
import { parseLocation, routeUid, type AppRoute } from './urlState';

/** What the current location shows. */
export function useLocationRoute(): AppRoute {
  const { pathname, search } = useLocation();
  return useMemo(() => parseLocation(pathname, search), [pathname, search]);
}

export function RouteSync() {
  const route = useLocationRoute();
  const ready = useAppStore((s) => s.loadState === 'ready');
  const uid = routeUid(route);
  const known = useAppStore((s) => uid !== null && s.boreholes.some((b) => b.uid === uid));
  const applyRoute = useAppStore((s) => s.applyRoute);

  useLayoutEffect(() => {
    if (ready) applyRoute(route);
  }, [route, ready, known, applyRoute]);

  return null;
}
