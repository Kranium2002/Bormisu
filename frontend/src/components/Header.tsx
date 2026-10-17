import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { APP_NAME } from '../config';
import { LANGS, useLang, useT } from '../i18n';
import { mapHref } from '../routing/navLinks';
import { useLocationRoute } from '../routing/RouteSync';
import { inboxPath, ROUTE, type RouteKind } from '../routing/urlState';
import { useAppStore } from '../store/appStore';
import { questionCountText, unresolvedCount } from './clarify/clarifyModel';
import { ChatButton } from './header/ChatButton';
import { UserMenu } from './header/UserMenu';
import styles from './Header.module.css';

type Section = 'map' | 'list' | 'queue' | 'inbox';

/**
 * The nav section a route belongs to: a borehole's detail and sheet are part of MAP, Review is part
 * of UPLOAD & QUEUE (it opens from a document there; there is no REVIEW tab).
 */
const SECTION: Record<RouteKind, Section | null> = {
  map: 'map',
  detail: 'map',
  sheet: 'map',
  list: 'list',
  queue: 'queue',
  reviewIndex: 'queue',
  review: 'queue',
  inbox: 'inbox',
  notFound: null,
};

/** Accessible name of the INBOX link: the count is part of it. */
export function inboxLinkLabel(n: number): string {
  return n > 0 ? `INBOX, ${questionCountText(n)}` : 'INBOX, no unresolved questions';
}

/**
 * Text for a polite live region when the number of unresolved questions changes (an answer, a skip, a
 * new question); nothing for the first count after loading.
 */
function useCountAnnouncement(n: number, ready: boolean): string {
  const [text, setText] = useState('');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (last.current !== null && last.current !== n) setText(`Inbox: ${questionCountText(n)}`);
    last.current = n;
  }, [n, ready]);
  return text;
}

/** EN | DE: the UI language, remembered in this browser. */
function LangSwitch() {
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const t = useT();
  return (
    <div className={styles.lang} role="group" aria-label={t('Language')}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          className={`${styles.langButton} ${lang === l ? styles.langActive : ''}`}
          aria-pressed={lang === l}
          title={l === 'en' ? 'English' : 'Deutsch'}
          onClick={() => setLang(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/**
 * App bar (frontend_din's black bar): the logo and product name (back to the map), the navigation MAP
 * · LIST · UPLOAD & QUEUE (amber badge = documents waiting for review) · INBOX (unresolved questions,
 * in its name and announced politely when the count changes), the search, EN | DE, CHAT and the user.
 *
 * The search filters while it is typed (the map keeps only the matching pins, LIST only the matching
 * rows); Enter jumps to the best match: the map flies to it, or LIST shows one without coordinates.
 * The link of the current section carries aria-current="page" and is underlined (MAP also on a
 * borehole's detail and sheet, UPLOAD & QUEUE on Review). MAP returns to the last map view.
 */
export function Header() {
  const t = useT();
  const section = SECTION[useLocationRoute().kind];
  const mapTo = useAppStore(mapHref);
  const needsReview = useAppStore((s) => s.documents.filter((d) => d.step === 2).length);
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const search = useAppStore((s) => s.search);
  const searchMessage = useAppStore((s) => s.searchMessage);
  const questions = useAppStore((s) => unresolvedCount(s.clarifications));
  const questionsState = useAppStore((s) => s.clarificationsState);
  const loadClarifications = useAppStore((s) => s.loadClarifications);
  const dataReady = useAppStore((s) => s.loadState === 'ready');
  const announcement = useCountAnnouncement(questions, questionsState === 'ready');
  const input = useRef<HTMLInputElement>(null);

  // The badge needs the questions on every screen: load them once the data is there, unless done.
  useEffect(() => {
    if (dataReady && questionsState === 'idle') void loadClarifications();
  }, [dataReady, questionsState, loadClarifications]);

  const item = (s: Section) => ({
    className: `${styles.navItem} ${section === s ? styles.active : ''}`,
    'aria-current': section === s ? ('page' as const) : undefined,
  });

  return (
    <header className={styles.header}>
      <Link to={mapTo} className={styles.brand} aria-label={`${APP_NAME}: ${t('go to the map')}`} data-main-nav="">
        <img className={styles.logo} src={`${import.meta.env.BASE_URL}logo.png`} width="40" height="40" alt="" />
        <span className={styles.name}>{APP_NAME}</span>
        <span className={styles.tagline}>{t('Borehole Intelligence')}</span>
      </Link>
      <nav className={styles.nav} aria-label="Main" data-main-nav="">
        <Link to={mapTo} {...item('map')}>
          {t('MAP')}
        </Link>
        <Link to={`/${ROUTE.list}`} {...item('list')}>
          {t('LIST')}
        </Link>
        <Link to={`/${ROUTE.queue}`} {...item('queue')}>
          {t('UPLOAD & QUEUE')}
          {needsReview > 0 && (
            <span className={styles.badge} title={`${needsReview} ${t('documents need review')}`}>
              {needsReview}
            </span>
          )}
        </Link>
        <Link to={inboxPath()} {...item('inbox')} aria-label={inboxLinkLabel(questions)}>
          {t('INBOX')}
          {questions > 0 && (
            <span className={styles.badge} aria-hidden="true">
              {questions}
            </span>
          )}
        </Link>
      </nav>
      <span className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <div className={styles.search}>
        <input
          ref={input}
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search();
            else if (e.key === 'Escape' && query) {
              // Clears the search first; the app's Escape (panels, dialogs) waits for the next press.
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              setQuery('');
            }
          }}
          placeholder={t('Search')}
          aria-label={t('Search project or borehole ID')}
          title={t('Filters the map and the list while you type; Enter jumps to the borehole')}
        />
        {query && (
          <button
            type="button"
            className={styles.clear}
            aria-label={t('Clear the search')}
            onClick={() => {
              setQuery('');
              input.current?.focus();
            }}
          >
            ×
          </button>
        )}
        {searchMessage && (
          <div className={styles.message} role="status">
            {searchMessage}
          </div>
        )}
      </div>
      <LangSwitch />
      <ChatButton />
      <UserMenu />
    </header>
  );
}
