import { useAppStore } from '../store/appStore';
import styles from './Toast.module.css';

/**
 * Bottom-centre toast; the store clears it after 3.2 s (8 s with an action). An action (e.g. SHOW ON
 * MAP after boreholes were placed) is a button: it runs once and closes the toast.
 */
export function Toast() {
  const toast = useAppStore((s) => s.toast);
  if (!toast) return null;
  const action = toast.action;
  return (
    <div key={toast.id} className={styles.toast} role="status" aria-live="polite">
      <span>{toast.text}</span>
      {action && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            useAppStore.setState((s) => (s.toast?.id === toast.id ? { toast: null } : {}));
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
