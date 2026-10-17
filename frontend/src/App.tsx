import { useEffect, type ComponentType } from 'react';
import styles from './App.module.css';
import { DemoBanner, SampleBanner } from './components/Banner';
import { EmptyState } from './components/EmptyState';
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
    return (
      <EmptyState
        tone="error"
        title="NO DATA"
        message={loadError ?? 'Loading failed.'}
        action={{ label: 'RETRY', onClick: () => void init() }}
      />
    );
  }
  const Active = SCREENS[screen];
  return <Active />;
}

/**
 * App shell: header, the mode banner (SAMPLE DATA in sample mode, demo mode when the backend has no
 * provider keys), the active screen and the overlays (side panel, CRS dialog, toast).
 */
export function App() {
  const init = useAppStore((s) => s.init);
  const escape = useAppStore((s) => s.escape);
  const sampleBanner = useAppStore((s) => s.sampleBannerVisible);
  const demoMode = useAppStore((s) => s.health?.mode === 'demo');
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
      {sampleBanner && <SampleBanner />}
      {demoMode && !sampleBanner && <DemoBanner />}
      <main className={styles.main}>
        <Body />
        <SidePanel />
        {crsDialogOpen && <CrsDialog />}
        <Toast />
      </main>
    </div>
  );
}
