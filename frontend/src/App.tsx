import { useEffect, type ComponentType } from 'react';
import styles from './App.module.css';
import { Banner, BACKEND_DEMO_BANNER_TEXT } from './components/Banner';
import { EmptyState, withInlineCode } from './components/EmptyState';
import { Header } from './components/Header';
import { SidePanel } from './components/SidePanel';
import { Toast } from './components/Toast';
import type { Screen } from './domain/types';
import { DetailScreen } from './screens/detail/DetailScreen';
import { MapScreen } from './screens/map/MapScreen';
import { QueueScreen } from './screens/queue/QueueScreen';
import { CrsDialog } from './screens/review/CrsDialog';
import { ReviewScreen } from './screens/review/ReviewScreen';
import { useAppStore } from './store/appStore';

const SCREENS: Record<Screen, ComponentType> = {
  map: MapScreen,
  queue: QueueScreen,
  review: ReviewScreen,
  detail: DetailScreen,
};

/** Loading / error / active screen. */
function Body() {
  const loadState = useAppStore((s) => s.loadState);
  const loadError = useAppStore((s) => s.loadError);
  const screen = useAppStore((s) => s.screen);
  const init = useAppStore((s) => s.init);
  if (loadState === 'loading') return <EmptyState title="LOADING" message="Loading boreholes and documents…" />;
  if (loadState === 'error') {
    // One title for an unreachable backend and a missing endpoint; the message says which and what to do.
    return (
      <EmptyState
        tone="error"
        title="NO DATA FROM THE BACKEND"
        message={withInlineCode(loadError ?? 'Loading failed. Check that the backend is running, then retry.')}
        action={{ label: 'RETRY', onClick: () => void init() }}
      />
    );
  }
  const Active = SCREENS[screen];
  return <Active />;
}

/** App shell: header, mode banner, the active screen and the overlays (side panel, CRS dialog, toast). */
export function App() {
  const init = useAppStore((s) => s.init);
  const escape = useAppStore((s) => s.escape);
  const backendDemo = useAppStore((s) => s.backendMode === 'demo');
  const crsDialogOpen = useAppStore((s) => s.crsDialogOpen);

  useEffect(() => {
    void init();
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
      <Header />
      {backendDemo && <Banner text={BACKEND_DEMO_BANNER_TEXT} />}
      <main className={styles.main}>
        <Body />
        <SidePanel />
        {crsDialogOpen && <CrsDialog />}
        <Toast />
      </main>
    </div>
  );
}
