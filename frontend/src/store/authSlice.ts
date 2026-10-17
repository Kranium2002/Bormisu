/**
 * Sign-in slice (contract 1.3.0). Placeholder of the M2/M3 foundation: the server has no sign-in
 * yet, so the state is "disabled" and nothing here is called. The auth work replaces this file.
 */
import type { SliceCreator } from './context';
import type { AuthSlice } from './types';

export const createAuthSlice: SliceCreator<AuthSlice> = () => ({
  authState: 'disabled',
  user: null,
  authBusy: false,
  authError: null,
  authFieldErrors: {},
  signIn: async () => false,
  register: async () => false,
  signOut: async () => undefined,
  changePassword: async () => false,
  sessionEnded: () => undefined,
});
