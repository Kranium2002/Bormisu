import { Link } from 'react-router';
import { useT } from '../i18n';
import { useAppStore } from '../store/appStore';
import { mapHref } from './navLinks';
import styles from './NotFound.module.css';

interface Props {
  title: string;
  message: string;
}

/** A URL that names nothing the app has: says so, with a link back to the map (never a blank screen). */
export function NotFound({ title, message }: Props) {
  const mapTo = useAppStore(mapHref);
  const t = useT();
  return (
    <div className={styles.wrap} data-screen-label="Not found">
      <div className={styles.card}>
        <h1 className={styles.title}>{t(title)}</h1>
        <p className={styles.message}>{t(message)}</p>
        <Link className={styles.link} to={mapTo}>
          {t('OPEN MAP')}
        </Link>
      </div>
    </div>
  );
}
