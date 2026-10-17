/**
 * How the store changes the URL. main.tsx injects the router's navigator into the store
 * (setNavigator); unit tests inject a fake or none, and without one the store's navigation actions
 * set the screen directly.
 */
import type { DataRouter } from 'react-router';

export interface AppNavigator {
  /** Goes to `to` (path and query); `replace` swaps the current history entry instead of adding one. */
  navigate(to: string, options?: { replace?: boolean }): void;
}

/** The navigator of a data router (createBrowserRouter). */
export function routerNavigator(router: DataRouter): AppNavigator {
  return {
    navigate(to, options) {
      void router.navigate(to, { replace: options?.replace === true });
    },
  };
}
