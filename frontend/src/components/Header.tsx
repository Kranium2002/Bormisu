import type { Screen } from '../domain/types';
import { useAppStore } from '../store/appStore';
import styles from './Header.module.css';

const NAV: { screen: Screen; label: string }[] = [
  { screen: 'map', label: 'MAP' },
  { screen: 'queue', label: 'UPLOAD & QUEUE' },
  { screen: 'review', label: 'REVIEW' },
];

/** App bar: brand, navigation (amber badge = documents waiting for review), search with a message popover. */
export function Header() {
  const screen = useAppStore((s) => s.screen);
  const go = useAppStore((s) => s.go);
  const needsReview = useAppStore((s) => s.documents.filter((d) => d.step === 2).length);
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const search = useAppStore((s) => s.search);
  const searchMessage = useAppStore((s) => s.searchMessage);

  return (
    <header className={styles.header}>
      <button type="button" className={styles.brand} onClick={() => go('map')} aria-label="Bormisu: go to the map">
        <div className={styles.logo} aria-hidden="true">H</div>
        <div className={styles.name}>BORMISU</div>
        <div className={styles.tagline}>Borehole Intelligence for Herrenknecht</div>
      </button>
      <nav className={styles.nav} aria-label="Main">
        {NAV.map((n) => {
          const active = screen === n.screen || (n.screen === 'map' && screen === 'detail');
          return (
            <button
              key={n.screen}
              type="button"
              className={`${styles.navItem} ${active ? styles.active : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => go(n.screen)}
            >
              {n.label}
              {n.screen === 'queue' && needsReview > 0 && (
                <span className={styles.badge} title={`${needsReview} documents need review`}>{needsReview}</span>
              )}
            </button>
          );
        })}
      </nav>
      <div className={styles.search}>
        <input
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search();
          }}
          placeholder="Search project or borehole ID  ⏎"
          aria-label="Search project or borehole ID"
        />
        {searchMessage && (
          <div className={styles.message} role="status">
            {searchMessage}
          </div>
        )}
      </div>
    </header>
  );
}
