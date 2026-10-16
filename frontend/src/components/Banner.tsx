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
