import { NavLink } from 'react-router';
import { APP_NAME } from '../config';
import { mapHref, reviewHref, reviewOffReason } from '../routing/navLinks';
import { useLocationRoute } from '../routing/RouteSync';
import type { RouteKind } from '../routing/urlState';
import { useAppStore } from '../store/appStore';
import styles from './Header.module.css';
import { ReviewerName } from './ReviewerName';

type Section = 'map' | 'queue' | 'review';

/** The nav section a route belongs to: a borehole's detail is part of MAP. */
const SECTION: Record<RouteKind, Section | null> = {
  map: 'map',
  detail: 'map',
  queue: 'queue',
  reviewIndex: 'review',
  review: 'review',
  notFound: null,
};

/**
 * App bar: brand, navigation links (amber badge = documents waiting for review), search with a message
 * popover, your name. The link to the current page carries aria-current="page"; its section is
 * underlined (MAP also on a borehole's detail). MAP returns to the last map view; REVIEW goes to the
 * last reviewed borehole or the first document in review, and is off with the reason when there is none.
 */
export function Header() {
  const section = SECTION[useLocationRoute().kind];
  const mapTo = useAppStore(mapHref);
  const reviewTo = useAppStore(reviewHref);
  const reviewOff = useAppStore((s) => reviewOffReason(s.loadState));
  const needsReview = useAppStore((s) => s.documents.filter((d) => d.step === 2).length);
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const search = useAppStore((s) => s.search);
  const searchMessage = useAppStore((s) => s.searchMessage);

  const itemClass = (s: Section) => ({ isActive }: { isActive: boolean }) =>
    `${styles.navItem} ${isActive || section === s ? styles.active : ''}`;

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <div className={styles.logo} aria-hidden="true">{APP_NAME.charAt(0)}</div>
        <div className={styles.name}>{APP_NAME}</div>
        <div className={styles.tagline}>Borehole Intelligence</div>
      </div>
      <nav className={styles.nav} aria-label="Main" data-main-nav="">
        <NavLink to={mapTo} end className={itemClass('map')}>
          MAP
        </NavLink>
        <NavLink to="/queue" end className={itemClass('queue')}>
          UPLOAD &amp; QUEUE
          {needsReview > 0 && (
            <span className={styles.badge} title={`${needsReview} documents need review`}>{needsReview}</span>
          )}
        </NavLink>
        {reviewTo ? (
          <NavLink to={reviewTo} end className={itemClass('review')}>
            REVIEW
          </NavLink>
        ) : (
          // Off: focusable, so keyboard and screen-reader users also get the reason.
          <span
            role="link"
            aria-disabled="true"
            tabIndex={0}
            title={reviewOff}
            className={`${styles.navItem} ${styles.off} ${section === 'review' ? styles.active : ''}`}
          >
            REVIEW
          </span>
        )}
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
      <ReviewerName />
    </header>
  );
}
