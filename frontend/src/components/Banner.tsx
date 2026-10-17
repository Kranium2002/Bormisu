import styles from './Banner.module.css';

/** The sample-mode text. e2e and the README quote it. */
export const SAMPLE_BANNER_TEXT = 'Demo mode: fictional sample loaded. Live extraction needs an API key.';

/** The API-mode text when the backend reports `mode: 'demo'` (no extraction key). */
export const BACKEND_DEMO_BANNER_TEXT = 'Backend in demo mode: live extraction needs an API key';

/**
 * Mode banner under the header, with the DEMO tag. It can't be dismissed: in sample mode the data on
 * screen is fictional, and a backend in demo mode can't extract new reports.
 */
export function Banner({ text }: { text: string }) {
  return (
    <div className={styles.banner} role="note">
      <span className={styles.tag}>DEMO</span>
      {text}
    </div>
  );
}

/** Sample-mode banner. */
export function SampleBanner() {
  return <Banner text={SAMPLE_BANNER_TEXT} />;
}
