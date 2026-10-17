import { useEffect, useRef, type RefObject } from 'react';
import { Outlet } from 'react-router';
import styles from './App.module.css';
import { DemoBanner, SampleBanner } from './components/Banner';
import { ClarificationHost } from './components/clarify/ClarificationHost';
import { DinPatternDefs } from './components/DinPatternDefs';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { SidePanel } from './components/SidePanel';
import { Toast } from './components/Toast';
import { RouteSync, useLocationRoute } from './routing/RouteSync';
import type { RouteKind } from './routing/urlState';
import { CrsDialog } from './screens/review/CrsDialog';
import { useAppStore } from './store/appStore';

/** Name of the main region per route: screen readers hear it when the focus moves there. */
const SCREEN_LABEL: Record<RouteKind, string> = {
  map: 'Map',
  queue: 'Upload & queue',
  reviewIndex: 'Extraction review',
  review: 'Extraction review',
  detail: 'Borehole detail',
  inbox: 'Questions inbox',
  notFound: 'Not found',
};

/** Loading / error / the route's screen. */
function Body() {
  const loadState = useAppStore((s) => s.loadState);
  const loadError = useAppStore((s) => s.loadError);
  const init = useAppStore((s) => s.init);
  if (loadState === 'loading') return <EmptyState title="LOADING" message="Loading boreholes and documents…" />;
  if (loadState === 'error') {
    return (
      <EmptyState
        tone="error"
        title="NO DATA"
        message={loadError ?? 'Loading failed.'}
        action={{ label: 'RETRY', onClick: () => void init() }}
      />
    );
  }
  return <Outlet />;
}

/**
 * After a screen change (a link, Back, an action), the focus goes to the main region when it was
 * left on nothing: on the page itself, in the main navigation, or on a control of the screen that
 * went away. A control that is still there (the search field, Review's borehole switcher) keeps it.
 */
function useScreenFocus(main: RefObject<HTMLElement | null>, pathname: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || !!active.closest('[data-main-nav]');
    const el = main.current;
    if (!lost || !el) return;
    // Focusable only for this: a lasting tabindex would take the focus on every click inside main.
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
  }, [main, pathname]);
}

/**
 * App shell and layout route: header, the mode banner (SAMPLE DATA in sample mode, demo mode when the
 * backend has no provider keys), the route's screen and the overlays (side panel, CRS dialog, toast),
 * which stay across routes. The DIN 4023 patterns are inlined once here, so every profile can fill
 * with `url(#<pattern_id>)`. RouteSync applies the URL to the store.
 */
export function App() {
  const init = useAppStore((s) => s.init);
  const escape = useAppStore((s) => s.escape);
  const sampleBanner = useAppStore((s) => s.sampleBannerVisible);
  const demoMode = useAppStore((s) => s.health?.mode === 'demo');
  const crsDialogOpen = useAppStore((s) => s.crsDialogOpen);
  const route = useLocationRoute();
  const mainRef = useRef<HTMLElement>(null);
  const screenPath = route.kind === 'review' || route.kind === 'detail' ? `${route.kind}/${route.uid}` : route.kind;
  useScreenFocus(mainRef, screenPath);

  useEffect(() => {
    void init();
    // init subscribes to live updates after loading; close the stream when the app goes away.
    return () => useAppStore.getState().stopLive();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') escape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escape]);

  return (
    <div className={styles.app}>
      <RouteSync />
      <DinPatternDefs />
      <Header />
      {sampleBanner && <SampleBanner />}
      {demoMode && !sampleBanner && <DemoBanner />}
      <main ref={mainRef} className={styles.main} aria-label={SCREEN_LABEL[route.kind]}>
        <Body />
        <SidePanel />
        {crsDialogOpen && <CrsDialog />}
        <ClarificationHost />
        <Toast />
      </main>
    </div>
  );
}
