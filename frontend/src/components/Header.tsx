import type { Screen } from '../domain/types';
import { useLang, useT } from '../i18n';
import { useAppStore } from '../store/appStore';
import styles from './Header.module.css';

const NAV: { screen: Screen; label: string }[] = [
  { screen: 'map', label: 'MAP' },
  { screen: 'list', label: 'LIST' },
  { screen: 'queue', label: 'UPLOAD & QUEUE' },
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
  const t = useT();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);

  return (
    <header className={styles.header}>
      <button type="button" className={styles.brand} onClick={() => go('map')} aria-label="Bormisu: go to the map">
        <img className={styles.logo} src={`${import.meta.env.BASE_URL}logo.png`} width="40" height="40" alt="" />
        <div className={styles.name}>BORMISU</div>
        <div className={styles.tagline}>{t('Borehole Intelligence for Herrenknecht')}</div>
      </button>
      <nav className={styles.nav} aria-label="Main">
        {NAV.map((n) => {
          // Detail belongs to MAP, the Review page to UPLOAD & QUEUE (it opens from a document there).
          const active = screen === n.screen || (n.screen === 'map' && screen === 'detail') || (n.screen === 'queue' && screen === 'review');
          return (
            <button
              key={n.screen}
              type="button"
              className={`${styles.navItem} ${active ? styles.active : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => go(n.screen)}
            >
              {t(n.label)}
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
          placeholder={t('Search')}
          aria-label={t('Search project or borehole ID')}
        />
        {searchMessage && (
          <div className={styles.message} role="status">
            {searchMessage}
          </div>
        )}
      </div>
      <div className={styles.lang} role="group" aria-label="Language">
        {(['en', 'de'] as const).map((l) => (
          <button key={l} type="button" className={`${styles.langButton} ${lang === l ? styles.langActive : ''}`}
            aria-pressed={lang === l} onClick={() => setLang(l)}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
    </header>
  );
}
