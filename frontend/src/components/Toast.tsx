import { useAppStore } from '../store/appStore';
import styles from './Toast.module.css';

/** Bottom-left toast (clear of the Review field list); the store clears it after 3.2 s. */
export function Toast() {
  const toast = useAppStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div key={toast.id} className={styles.toast} role="status" aria-live="polite">
      {toast.text}
    </div>
  );
}
