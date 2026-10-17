/**
 * Sign-in slice (contract 1.3.0). With health.auth.enabled the app loads nothing until a user is
 * signed in (init in the data slice checks GET /auth/me); sign-in and registration load the data and
 * start live updates; sign-out and an ended session (any 401 not_authenticated, reported by the
 * source's session listener) forget every loaded record and show the sign-in on the same URL.
 */
import { errorText, isApiError, UnreachableError } from '../data/errors';
import type { SliceCreator } from './context';
import type { AppState, AuthSlice } from './types';

export const INVALID_CREDENTIALS = 'Email or password is wrong.';
export const EMAIL_TAKEN = 'An account with this email exists. Sign in instead.';
export const SESSION_ENDED = 'Your session ended. Sign in again.';
export const WRONG_CURRENT_PASSWORD = 'The current password is wrong.';
export const CHECK_FIELDS = 'Check the fields marked below.';

/** "Too many attempts. Try again in N minutes." with the server's wait when it sent one. */
export function rateLimitText(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds == null) return 'Too many attempts. Try again later.';
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * Field errors of a 422 by field name: the last string of each `loc` (["body", "password"] →
 * password). The first message per field wins.
 */
export function fieldErrorsOf(e: unknown): Record<string, string> {
  if (!isApiError(e) || e.status !== 422) return {};
  const out: Record<string, string> = {};
  for (const fe of e.errors) {
    const field = [...fe.loc].reverse().find((x): x is string => typeof x === 'string');
    if (field && !(field in out)) out[field] = fe.msg || 'Not accepted.';
  }
  return out;
}

/** What a failed sign-in, registration or password change shows: the top message and field errors. */
export function authErrorOf(e: unknown): Pick<AppState, 'authError' | 'authFieldErrors'> {
  if (e instanceof UnreachableError) return { authError: e.message, authFieldErrors: {} };
  if (isApiError(e, 'invalid_credentials')) return { authError: INVALID_CREDENTIALS, authFieldErrors: {} };
  if (isApiError(e, 'email_taken')) return { authError: EMAIL_TAKEN, authFieldErrors: { email: EMAIL_TAKEN } };
  if (isApiError(e, 'rate_limited') || (isApiError(e) && e.status === 429)) {
    return { authError: rateLimitText(e.retryAfter), authFieldErrors: {} };
  }
  const fields = fieldErrorsOf(e);
  if (Object.keys(fields).length) return { authError: CHECK_FIELDS, authFieldErrors: fields };
  return { authError: errorText(e) || 'That did not work. Try again.', authFieldErrors: {} };
}

export const createAuthSlice: SliceCreator<AuthSlice> = ({ set, get }) => {
  /** A signed-in user: the data loads and live updates start, as at boot. */
  function signedIn(user: AppState['user']): void {
    set({ user, authState: 'signedIn', authBusy: false, authError: null, authFieldErrors: {} });
    void get().loadData();
  }

  return {
    authState: 'unknown',
    user: null,
    authBusy: false,
    authError: null,
    authFieldErrors: {},

    async signIn(email, password) {
      const source = get().source;
      if (!source || get().authBusy) return false;
      set({ authBusy: true, authError: null, authFieldErrors: {} });
      try {
        signedIn(await source.signIn(email, password));
        return true;
      } catch (e) {
        set({ authBusy: false, ...authErrorOf(e) });
        return false;
      }
    },

    async register(registration) {
      const source = get().source;
      if (!source || get().authBusy) return false;
      set({ authBusy: true, authError: null, authFieldErrors: {} });
      try {
        signedIn(await source.register(registration));
        return true;
      } catch (e) {
        set({ authBusy: false, ...authErrorOf(e) });
        return false;
      }
    },

    async signOut() {
      const source = get().source;
      set({ authBusy: true });
      try {
        await source?.signOut();
      } catch (e) {
        // Signed out on this side anyway; the server's session ends with its cookie's lifetime.
        console.warn(`Signing out on the server failed (${errorText(e)}).`);
      }
      get().resetData();
      set({ authState: 'signedOut', user: null, authBusy: false, authError: null, authFieldErrors: {} });
    },

    async changePassword(currentPassword, newPassword) {
      const source = get().source;
      if (!source || get().authBusy) return false;
      set({ authBusy: true, authError: null, authFieldErrors: {} });
      try {
        await source.changePassword(currentPassword, newPassword);
        set({ authBusy: false });
        return true;
      } catch (e) {
        // Here a 401 invalid_credentials means the current password, not the sign-in.
        if (isApiError(e, 'invalid_credentials')) {
          set({ authBusy: false, authError: WRONG_CURRENT_PASSWORD, authFieldErrors: { current_password: WRONG_CURRENT_PASSWORD } });
        } else {
          set({ authBusy: false, ...authErrorOf(e) });
        }
        return false;
      }
    },

    sessionEnded() {
      // Once: a burst of 401s, or one after signing out, changes nothing more.
      if (get().authState === 'signedOut') return;
      get().resetData();
      set({ authState: 'signedOut', user: null, authBusy: false, authError: SESSION_ENDED, authFieldErrors: {} });
    },

    clearAuthErrors() {
      if (get().authError === null && !Object.keys(get().authFieldErrors).length) return;
      set({ authError: null, authFieldErrors: {} });
    },
  };
};

/** The name the store sends as confirmed_by / answered_by: null when signed in (the server takes the session's user). */
export function signatureOf(s: Pick<AppState, 'authState' | 'reviewerName'>): string | null {
  return s.authState === 'signedIn' ? null : s.reviewerName;
}
