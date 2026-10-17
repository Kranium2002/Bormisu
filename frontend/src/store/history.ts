import type { Screen } from '../domain/types';
import { useAppStore } from './appStore';

/** Where the user is: the screen, plus the borehole on Detail and on Review. One browser history entry each. */
interface Place { screen: Screen; uid: string | null }

type State = ReturnType<typeof useAppStore.getState>;
const placeOf = (s: State): Place => ({
  screen: s.screen,
  uid: s.screen === 'detail' ? s.selectedUid : s.screen === 'review' ? s.reviewUid : null,
});
const same = (a: Place, b: Place) => a.screen === b.screen && a.uid === b.uid;

/**
 * Browser back / forward walk through the app's screens instead of leaving it: every move to another
 * place pushes a history entry, and back / forward restores it through the store's own navigation
 * (so its side effects run). The URL stays as it is. Returns the cleanup.
 */
export function syncBrowserHistory(): () => void {
  let restoring = false;
  window.history.replaceState(placeOf(useAppStore.getState()), '');

  const unsubscribe = useAppStore.subscribe((s, prev) => {
    const now = placeOf(s);
    if (!restoring && !same(now, placeOf(prev))) window.history.pushState(now, '');
  });

  const onPop = (e: PopStateEvent) => {
    const place = e.state as Place | null;
    if (!place?.screen) return;
    const store = useAppStore.getState();
    restoring = true;
    try {
      if (place.screen === 'detail' && place.uid && store.boreholes.some((b) => b.uid === place.uid)) store.openBorehole(place.uid);
      else if (place.screen === 'review') store.openReview(place.uid ?? undefined);
      else store.go(place.screen === 'detail' ? 'map' : place.screen);
    } finally {
      restoring = false;
    }
  };
  window.addEventListener('popstate', onPop);

  return () => {
    unsubscribe();
    window.removeEventListener('popstate', onPop);
  };
}
