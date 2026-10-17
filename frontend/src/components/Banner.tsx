import { useT } from '../i18n';
import { DEMO_UPLOAD_REASON } from '../store/uploads';
import styles from './Banner.module.css';

/** Sample-mode banner. It can't be dismissed: the data on screen is fictional. */
export function SampleBanner() {
  const t = useT();
  return (
    <div className={styles.banner} role="note">
      <span className={styles.tag}>DEMO</span>
      {t('Demo mode: fictional sample loaded. Live extraction needs an API key.')}
    </div>
  );
}

/** API demo mode (the backend has no provider keys): uploads are off; stored data can still be reviewed. */
export function DemoBanner() {
  const t = useT();
  return (
    <div className={styles.banner} role="note">
      <span className={styles.tag}>{t('DEMO MODE')}</span>
      {t(DEMO_UPLOAD_REASON)}. {t('Uploading is off; the boreholes already stored can be reviewed and exported.')}
    </div>
  );
}
