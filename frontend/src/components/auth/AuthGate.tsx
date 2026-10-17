import type { ReactNode } from 'react';
import { useAppStore } from '../../store/appStore';
import styles from './Auth.module.css';
import { SignInScreen } from './SignInScreen';

/**
 * Shows the app, or the sign-in when the server needs a session and there is none (contract 1.3.0).
 *
 * - `disabled` (the server has no sign-in, sample mode) and `signedIn`: the app.
 * - `unknown` (health and the session are being checked): a centred loading state. A boot that
 *   failed before it knew (backend unreachable) shows the app, whose NO DATA state has RETRY.
 * - `signedOut`: the sign-in screen on the same URL, so the user returns to it after signing in.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const authState = useAppStore((s) => s.authState);
  const bootFailed = useAppStore((s) => s.loadState === 'error');
  if (authState === 'signedOut') return <SignInScreen />;
  if (authState === 'unknown' && !bootFailed) {
    return (
      <div className={styles.loading} role="status" aria-live="polite">
        LOADING…
      </div>
    );
  }
  return <>{children}</>;
}
