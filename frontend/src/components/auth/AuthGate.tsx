import type { ReactNode } from 'react';

/**
 * Shows the app, or the sign-in when the server needs a session and there is none. Placeholder of
 * the M3 foundation (the server has no sign-in yet): the auth work fills it.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
