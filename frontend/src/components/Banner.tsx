import styles from './Banner.module.css';

/** The API-mode text when the backend reports `mode: 'demo'` (no extraction key). */
export const BACKEND_DEMO_BANNER_TEXT = 'Backend in demo mode: live extraction needs an API key';

/** Mode banner under the header, with the DEMO tag: a backend in demo mode can't extract new reports. */
export function Banner({ text }: { text: string }) {
  return (
    <div className={styles.banner} role="note">
      <span className={styles.tag}>DEMO</span>
      {text}
    </div>
  );
}
