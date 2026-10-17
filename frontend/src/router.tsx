/**
 * Routes (FRONTEND.md section 3 "Routing", F4): react-router in library (data) mode. App is the
 * layout (header, banners, overlays); the screens render in its outlet. The URLs themselves are built
 * and read in src/routing/urlState.ts.
 *
 *   /                 → /map
 *   /map              map (?at=lat,lng,zoom &sel=uid &rs=result set)
 *   /queue            upload & queue
 *   /review           the review target, else "nothing to review"
 *   /review/:uid      review of a borehole (?key=value key)
 *   /boreholes/:uid   borehole detail (?layer=n)
 *   /inbox            clarification questions (?q=question whose dialog is open)
 *   anything else     not found, with a link to the map
 *
 * No loaders: the store loads the data, and navigation stays synchronous. nginx serves index.html for
 * every path, so deep links and reloads work in the Docker build.
 */
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { App } from './App';
import {
  BoreholeRoute,
  InboxRoute,
  MapRoute,
  NotFoundRoute,
  QueueRoute,
  ReviewIndexRoute,
  ReviewRoute,
  RouteError,
} from './routing/screens';
import { ROUTE } from './routing/urlState';

export const routes: RouteObject[] = [
  {
    path: '/',
    Component: App,
    ErrorBoundary: RouteError,
    children: [
      {
        // A screen that throws shows its error inside the app shell.
        ErrorBoundary: RouteError,
        children: [
          { index: true, element: <Navigate to={`/${ROUTE.map}`} replace /> },
          { path: ROUTE.map, Component: MapRoute },
          { path: ROUTE.queue, Component: QueueRoute },
          { path: ROUTE.reviewIndex, Component: ReviewIndexRoute },
          { path: ROUTE.review, Component: ReviewRoute },
          { path: ROUTE.detail, Component: BoreholeRoute },
          { path: ROUTE.inbox, Component: InboxRoute },
          { path: '*', Component: NotFoundRoute },
        ],
      },
    ],
  },
];

/** The app's browser router (created once in main.tsx). */
export function createAppRouter() {
  return createBrowserRouter(routes);
}
