/**
 * Sign-in in the store (contract 1.3.0) with fake sources (fictional accounts and data only): the
 * boot without sign-in, signed out and signed in; sign-in, registration and their errors (422 field
 * errors, rate limit text, unreachable); sign-out and an ended session forget every loaded record
 * and keep the route; password change; the session's user replaces the typed name in what the store
 * sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { ApiError, UnreachableError } from '../data/errors';
import type { CrsCandidate, User } from '../domain/types';
import type { AppNavigator } from '../routing/navigator';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { fakeSource, makeClarification, makeHealth, manualLive, manualUploads, settle, testFile, type FakeSource } from './testing';

/** init() asks createDataSource once; it gets a proxy that forwards to the current fake source. */
let current: DataSource;
const proxy = new Proxy({} as DataSource, {
  get: (_t, prop: keyof DataSource) => {
    const v = current[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
  },
});
vi.mock('../data/createDataSource', () => ({
  createDataSource: async () => proxy,
  dataSourceKind: () => 'api',
  apiBase: () => '/api/v1',
}));
const { useAppStore } = await import('./appStore');
const { EMAIL_TAKEN, INVALID_CREDENTIALS, SESSION_ENDED, WRONG_CURRENT_PASSWORD, rateLimitText, fieldErrorsOf, signatureOf } = await import('./authSlice');

const st = () => useAppStore.getState();
const initial = useAppStore.getState();

const UID = makeBorehole().uid;
const OFF = makeBorehole({ uid: 'bh_TEST0000000000000000000002', id: 'TB-02', onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' });
const doc = makeDocument({ reviewBoreholeUid: UID });
const QUESTION = makeClarification({ id: 'cl_TEST_AUTH_1', documentId: doc.id, boreholeUids: [UID] });

const USER: User = {
  userId: 'usr_TEST_000000000000000001',
  email: 'ada.reviewer@example.test',
  displayName: 'Ada Reviewer',
  role: 'reviewer',
  createdAt: '2026-10-17T07:00:00Z',
};

const AUTH_ON = makeHealth({ auth: { enabled: true, registration: 'open' } });

let live: ReturnType<typeof manualLive>;
/** The listener the store gave the source at init. */
let listener: (() => void) | null;

/** A fake source with sign-in on (unless `health` says otherwise); `over` replaces methods. */
function source(over: Partial<DataSource> = {}): FakeSource & { load: ReturnType<typeof vi.fn> } {
  live = manualLive();
  listener = null;
  const fake = fakeSource(
    { boreholes: [makeBorehole(), OFF], documents: [doc], clarifications: [QUESTION] },
    {
      health: async () => AUTH_ON,
      subscribe: live.subscribe,
      setSessionListener: (l) => {
        listener = l;
      },
      signIn: async () => USER,
      register: async (r) => ({ ...USER, email: r.email, displayName: r.displayName }),
      ...over,
    },
  );
  const load = vi.fn(fake.load);
  fake.load = load;
  current = fake;
  return fake as FakeSource & { load: typeof load };
}

/** A store signed in with everything loaded, the route on the unplotted borehole's detail. */
async function signedInStore(over: Partial<DataSource> = {}) {
  const fake = source({ currentUser: async () => USER, ...over });
  await st().init();
  await vi.waitFor(() => expect(st().clarificationsState).toBe('ready'));
  st().applyRoute({ kind: 'detail', uid: OFF.uid, layer: null });
  return fake;
}

beforeEach(() => {
  st().stopLive();
  useAppStore.setState(initial, true);
});
afterEach(() => vi.useRealTimers());

describe('boot', () => {
  it('starts unknown in API mode', () => {
    expect(initial.authState).toBe('unknown');
  });

  it('without auth in health (sign-in off): disabled, and everything loads as before', async () => {
    const fake = source({ health: async () => makeHealth() });
    const currentUser = vi.spyOn(fake, 'currentUser');
    await st().init();
    expect(st()).toMatchObject({ authState: 'disabled', user: null, loadState: 'ready' });
    expect(currentUser).not.toHaveBeenCalled();
    expect(fake.load).toHaveBeenCalledTimes(1);
    expect(live.subscriptions).toHaveLength(1);
  });

  it('a failed health check loads as without sign-in (a 401 later still shows the sign-in)', async () => {
    const fake = source({ health: () => Promise.reject(new UnreachableError('down')) });
    await st().init();
    expect(st()).toMatchObject({ authState: 'disabled', health: null, loadState: 'ready' });
    expect(fake.load).toHaveBeenCalledTimes(1);
  });

  it('sign-in on, no session: signed out, nothing loaded, no live updates', async () => {
    const fake = source({ currentUser: async () => null });
    await st().init();
    expect(st()).toMatchObject({ authState: 'signedOut', user: null, authError: null });
    expect(fake.load).not.toHaveBeenCalled();
    expect(live.subscriptions).toHaveLength(0);
    expect(st().documents).toEqual([]);
  });

  it('sign-in on, a session: signed in, then loads and subscribes as before', async () => {
    const fake = await signedInStore();
    expect(st()).toMatchObject({ authState: 'signedIn', user: USER, loadState: 'ready' });
    expect(fake.load).toHaveBeenCalledTimes(1);
    expect(st().documents.map((d) => d.id)).toEqual([doc.id]);
    expect(live.subscriptions.filter((s) => !s.closed)).toHaveLength(1);
    expect(st().clarifications.map((c) => c.id)).toEqual([QUESTION.id]);
  });

  it('a failing session check is a boot error with its message (RETRY), not a sign-in', async () => {
    source({ currentUser: () => Promise.reject(new UnreachableError('Cannot reach the backend.')) });
    await st().init();
    expect(st()).toMatchObject({ authState: 'unknown', loadState: 'error', loadError: 'Cannot reach the backend.' });
  });

  it('gives the source a session listener that ends the session', async () => {
    await signedInStore();
    expect(listener).toBeTypeOf('function');
    listener?.();
    expect(st()).toMatchObject({ authState: 'signedOut', authError: SESSION_ENDED });
  });
});

describe('signIn and register', () => {
  beforeEach(async () => {
    source({ currentUser: async () => null });
    await st().init();
  });

  it('signIn sets the user, then loads the data and starts live updates', async () => {
    const signIn = vi.spyOn(current, 'signIn');
    expect(await st().signIn('ada.reviewer@example.test', 'fictional-pass-phrase')).toBe(true);
    expect(signIn).toHaveBeenCalledWith('ada.reviewer@example.test', 'fictional-pass-phrase');
    expect(st()).toMatchObject({ authState: 'signedIn', user: USER, authBusy: false, authError: null });
    await vi.waitFor(() => expect(st().loadState).toBe('ready'));
    expect(st().documents).toHaveLength(1);
    expect(live.subscriptions.filter((s) => !s.closed)).toHaveLength(1);
  });

  it('is busy while the request runs and ignores a second submit', async () => {
    let answer!: (u: User) => void;
    const signIn = vi.fn(() => new Promise<User>((r) => (answer = r)));
    (current as FakeSource).signIn = signIn;
    const first = st().signIn('ada.reviewer@example.test', 'x');
    expect(st().authBusy).toBe(true);
    expect(await st().signIn('ada.reviewer@example.test', 'x')).toBe(false);
    answer(USER);
    expect(await first).toBe(true);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid_credentials', new ApiError(401, 'invalid_credentials', 'Invalid email or password.'), INVALID_CREDENTIALS],
    ['unreachable', new UnreachableError('Cannot reach the Bormisu backend at /api/v1.'), 'Cannot reach the Bormisu backend at /api/v1.'],
    ['another error', new ApiError(500, 'internal', 'Something broke on the server.'), 'Something broke on the server.'],
  ])('signIn failing with %s shows its message and stays signed out', async (_name, e, text) => {
    (current as FakeSource).signIn = async () => {
      throw e;
    };
    expect(await st().signIn('ada.reviewer@example.test', 'wrong')).toBe(false);
    expect(st()).toMatchObject({ authState: 'signedOut', authBusy: false, authError: text, authFieldErrors: {} });
    expect(current.load).not.toHaveBeenCalled();
  });

  it('a rate limit says how long to wait when the server said', async () => {
    const limited = new ApiError(429, 'rate_limited', 'Too many attempts.');
    limited.retryAfter = 150;
    (current as FakeSource).signIn = async () => {
      throw limited;
    };
    await st().signIn('ada.reviewer@example.test', 'x');
    expect(st().authError).toBe('Too many attempts. Try again in 3 minutes.');
    expect(rateLimitText(30)).toBe('Too many attempts. Try again in 1 minute.');
    expect(rateLimitText(null)).toBe('Too many attempts. Try again later.');
  });

  it('register signs the new account in and loads', async () => {
    const register = vi.spyOn(current, 'register');
    const r = { email: 'new@example.test', password: 'fictional-long-passphrase', displayName: 'New Person' };
    expect(await st().register(r)).toBe(true);
    expect(register).toHaveBeenCalledWith(r);
    expect(st()).toMatchObject({ authState: 'signedIn', user: { email: 'new@example.test', displayName: 'New Person' } });
    await vi.waitFor(() => expect(st().loadState).toBe('ready'));
  });

  it('register: email_taken shows on top and at the email field', async () => {
    (current as FakeSource).register = async () => {
      throw new ApiError(409, 'email_taken', 'Email already registered.');
    };
    expect(await st().register({ email: 'ada.reviewer@example.test', password: 'fictional-long-passphrase', displayName: null })).toBe(false);
    expect(st()).toMatchObject({ authState: 'signedOut', authError: EMAIL_TAKEN, authFieldErrors: { email: EMAIL_TAKEN } });
  });

  it('register: the field errors of a 422 go to their fields by the last name in loc', async () => {
    (current as FakeSource).register = async () => {
      throw new ApiError(422, 'validation_error', 'Invalid request.', [
        { loc: ['body', 'password'], msg: 'This password is too common.' },
        { loc: ['body', 'password'], msg: 'A second message for the same field.' },
        { loc: ['body', 'display_name', 0], msg: 'At most 80 characters.' },
      ]);
    };
    await st().register({ email: 'new@example.test', password: 'password1234', displayName: null });
    expect(st().authFieldErrors).toEqual({ password: 'This password is too common.', display_name: 'At most 80 characters.' });
    expect(st().authError).toBe('Check the fields marked below.');
    expect(fieldErrorsOf(new ApiError(409, 'email_taken', 'x', [{ loc: ['body', 'email'], msg: 'x' }]))).toEqual({});
  });

  it('clearAuthErrors empties the message and the field errors', async () => {
    (current as FakeSource).signIn = async () => {
      throw new ApiError(401, 'invalid_credentials', 'x');
    };
    await st().signIn('a@example.test', 'x');
    st().clearAuthErrors();
    expect(st()).toMatchObject({ authError: null, authFieldErrors: {} });
  });
});

describe('signOut and an ended session', () => {
  /** Every loaded record and the state built on it is gone. */
  function expectForgotten() {
    expect(st()).toMatchObject({
      authState: 'signedOut',
      user: null,
      boreholes: [],
      documents: [],
      features: [],
      unplottedUids: [],
      clarifications: [],
      pages: {},
      resultSet: null,
      resultSetId: null,
      uploads: [],
      reviewUid: null,
      selectedUid: null,
      focusKey: null,
      editing: null,
      crsDialogOpen: false,
      panel: null,
      activeClarificationId: null,
      route: null,
      chatOpen: false,
    });
    expect(live.subscriptions.every((s) => s.closed)).toBe(true);
  }

  it('signOut posts the sign-out, stops live updates and forgets every loaded record; the URL stays', async () => {
    const fake = await signedInStore();
    const navigate = vi.fn<AppNavigator['navigate']>();
    st().setNavigator({ navigate });
    await st().loadPage(doc.id, 1);
    st().openCompleteness(doc.id);
    const signOut = vi.spyOn(fake, 'signOut');
    await st().signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expectForgotten();
    expect(st().authError).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('signOut cancels the uploads in flight and empties the queue', async () => {
    const manual = manualUploads();
    await signedInStore({ upload: manual.upload });
    st().addFiles([testFile('fictional-a.pdf'), testFile('fictional-b.pdf'), testFile('fictional-c.pdf')]);
    await settle();
    expect(manual.uploads.length).toBeGreaterThan(0);
    await st().signOut();
    expect(manual.uploads.every((u) => u.cancelled)).toBe(true);
    expect(st().uploads).toEqual([]);
  });

  it('a failing sign-out request still signs out on this side', async () => {
    await signedInStore({ signOut: () => Promise.reject(new UnreachableError('down')) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await st().signOut();
    expectForgotten();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('sessionEnded: the same clean-up without a request, the message, and the route kept', async () => {
    const fake = await signedInStore();
    const navigate = vi.fn<AppNavigator['navigate']>();
    st().setNavigator({ navigate });
    const signOut = vi.spyOn(fake, 'signOut');
    st().sessionEnded();
    expectForgotten();
    expect(st().authError).toBe(SESSION_ENDED);
    expect(signOut).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // A second 401 of the same burst changes nothing.
    useAppStore.setState({ authError: 'kept' });
    st().sessionEnded();
    expect(st().authError).toBe('kept');
  });

  it('after an ended session, signing in loads again and the route applies again', async () => {
    await signedInStore();
    st().sessionEnded();
    expect(await st().signIn(USER.email, 'fictional-pass-phrase')).toBe(true);
    await vi.waitFor(() => expect(st().loadState).toBe('ready'));
    expect(st().documents).toHaveLength(1);
    // The route sync shows the URL's screen again (route null means "not shown yet").
    st().applyRoute({ kind: 'detail', uid: OFF.uid, layer: null });
    expect(st()).toMatchObject({ screen: 'detail', selectedUid: OFF.uid });
  });

  it('a load that answers after the session ended is ignored', async () => {
    let answer!: () => void;
    const fake = source({ currentUser: async () => USER });
    const load = fake.load.getMockImplementation() as DataSource['load'];
    fake.load.mockImplementation(() => new Promise((r) => (answer = () => r(load()))));
    const booting = st().init();
    await vi.waitFor(() => expect(fake.load).toHaveBeenCalled());
    st().sessionEnded();
    answer();
    await booting;
    expect(st().documents).toEqual([]);
    expect(st().authState).toBe('signedOut');
  });
});

describe('changePassword', () => {
  beforeEach(() => signedInStore());

  it('sends both passwords and stays signed in', async () => {
    const change = vi.spyOn(current, 'changePassword');
    expect(await st().changePassword('fictional-old-phrase', 'fictional-new-phrase')).toBe(true);
    expect(change).toHaveBeenCalledWith('fictional-old-phrase', 'fictional-new-phrase');
    expect(st()).toMatchObject({ authState: 'signedIn', authBusy: false, authError: null });
  });

  it('a wrong current password is shown at that field', async () => {
    (current as FakeSource).changePassword = async () => {
      throw new ApiError(401, 'invalid_credentials', 'x');
    };
    expect(await st().changePassword('wrong', 'fictional-new-phrase')).toBe(false);
    expect(st()).toMatchObject({ authState: 'signedIn', authError: WRONG_CURRENT_PASSWORD, authFieldErrors: { current_password: WRONG_CURRENT_PASSWORD } });
  });

  it('field errors of a 422 go to their fields', async () => {
    (current as FakeSource).changePassword = async () => {
      throw new ApiError(422, 'validation_error', 'x', [{ loc: ['body', 'new_password'], msg: 'This password is too common.' }]);
    };
    await st().changePassword('fictional-old-phrase', 'password1234');
    expect(st().authFieldErrors).toEqual({ new_password: 'This password is too common.' });
  });

  it('an ended session (401 not_authenticated) shows the sign-in', async () => {
    (current as FakeSource).changePassword = async () => {
      throw new ApiError(401, 'not_authenticated', 'x');
    };
    expect(await st().changePassword('a', 'fictional-new-phrase')).toBe(false);
    expect(st()).toMatchObject({ authState: 'signedOut', authError: SESSION_ENDED });
  });
});

describe('the name sent with confirmations and answers', () => {
  it('is the typed name without sign-in and null when signed in (the server takes the session user)', () => {
    expect(signatureOf({ authState: 'disabled', reviewerName: 'A. Typed' })).toBe('A. Typed');
    expect(signatureOf({ authState: 'signedIn', reviewerName: 'A. Typed' })).toBeNull();
  });

  it('confirmCrs and answerClarification send null when signed in', async () => {
    const candidate: CrsCandidate = {
      name: 'Fictional CRS', code: 'EPSG:0000', note: null, score: 1, verdict: 'match', swapAxes: false, points: [],
    };
    const fake = await signedInStore({ crsCandidates: async () => [candidate] });
    st().setReviewerName('A. Typed');
    const confirm = vi.spyOn(fake, 'confirmCrs');
    const answer = vi.spyOn(fake, 'answerClarification');
    await st().ensureBorehole(UID);
    useAppStore.setState({ reviewUid: UID });
    await st().openCrsDialog();
    await st().confirmCrs();
    expect(confirm).toHaveBeenCalledWith(doc.id, expect.objectContaining({ confirmedBy: null }));
    await st().answerClarification(QUESTION.id, { value: 'fictional' });
    expect(answer).toHaveBeenCalledWith(QUESTION.id, { value: 'fictional' }, null);
    st().setReviewerName('');
  });
});
