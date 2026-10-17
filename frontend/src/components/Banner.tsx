import { DEMO_UPLOAD_REASON } from '../store/uploads';
import styles from './Banner.module.css';

/** Sample-mode banner. It can't be dismissed: the data on screen is fictional. */
export function SampleBanner() {
  return (
    <div className={styles.banner} role="note">
      <span className={styles.tag}>DEMO</span>
      Demo mode: fictional sample loaded. Live extraction needs an API key.
    </div>
  );
}

/** API demo mode (the backend has no provider keys): uploads are off; stored data can still be reviewed. */
export function DemoBanner() {
  return (
    <div className={styles.banner} role="note">
      <span className={styles.tag}>DEMO MODE</span>
      {DEMO_UPLOAD_REASON}. Uploading is off; the boreholes already stored can be reviewed and exported.
    </div>
  );
}
