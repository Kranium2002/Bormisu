/**
 * Sign-in in API mode (contract 1.3.0) against a fictional backend: fetch, XMLHttpRequest and
 * EventSource mocked, nothing leaves the process. Every endpoint and error code, the user adapter,
 * Retry-After, and the session listener: it fires once per burst of 401 not_authenticated answers of
 * normal requests (fetch and the XHR upload), never for the sign-in endpoints whose 401 is an answer,
 * and a failing event stream checks the session. Fictional accounts only (example.test).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fixture } from '../test/contract/wire';
import { adaptUser, type WireUser } from './adapters';
import { createApiSource, endsSession } from './apiSource';
import { ApiError, parseRetryAfter, UnreachableError } from './errors';
import { STREAM_RETRY_MS } from './events';
import { MockEventSource, MockXhr } from './testing';

const BASE = '/api/v1';

const WIRE_USER: WireUser = {
  user_id: 'usr_01JFICT000000000000000U01',
  email: 'ada.reviewer@example.test',
  display_name: 'Ada Reviewer',
  role: 'admin',
  created_at: '2026-10-17T07:00:00Z',
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const noContent = () => new Response(null, { status: 204 });
const error = (status: number, code: string, detail = `fictional ${code}`, errors?: { loc: (string | number)[]; msg: string }[], headers: Record<string, string> = {}) =>
  json(status, { detail, code, ...(errors ? { errors } : {}) }, headers);
const notAuthenticated = () => error(401, 'not_authenticated', 'Sign in first.');

interface Call { method: string; path: string; body?: Record<string, unknown> }
type Route = (call: Call) => Response | Promise<Response> | undefined;

/**
 * A fictional backend with sign-in. `route` answers first; then health (auth on), the boot's lists
 * and the auth endpoints as a happy server would.
 */
function backend(route: Route = () => undefined) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: Call = { method: init?.method ?? 'GET', path: url.slice(BASE.length), body };
    calls.push(call);
    const own = await route(call);
    if (own) return own;
    const { method, path } = call;
    if (method === 'GET' && path === '/health') return json(200, { ...fixture<object>('health-live'), auth: { enabled: true, registration: 'open' } });
    if (method === 'GET' && path === '/auth/me') return json(200, { user: WIRE_USER });
    if (method === 'POST' && path === '/auth/login') return json(200, { user: WIRE_USER });
    if (method === 'POST' && path === '/auth/register') return json(201, { user: WIRE_USER });
    if (method === 'POST' && (path === '/auth/logout' || path === '/auth/password')) return noContent();
    if (method === 'GET' && path === '/map/boreholes.geojson') return json(200, fixture('map-features'));
    if (method === 'GET' && path.startsWith('/boreholes?plotted=false')) return json(200, { count: 0, boreholes: [], next_cursor: null });
    if (method === 'GET' && path === '/documents') return json(200, fixture('documents'));
    return error(404, 'route_not_found');
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}

/** A source with a listener that counts ended sessions. */
function source() {
  const api = createApiSource(BASE);
  const ended = vi.fn();
  api.setSessionListener(ended);
  return { api, ended };
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  MockXhr.reset();
  MockEventSource.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe('adaptUser', () => {
  it('maps the wire user to the domain user', () => {
    expect(adaptUser(WIRE_USER)).toEqual({
      userId: WIRE_USER.user_id,
      email: 'ada.reviewer@example.test',
      displayName: 'Ada Reviewer',
      role: 'admin',
      createdAt: '2026-10-17T07:00:00Z',
    });
  });

  it('a missing or blank display name is null, never a made-up one', () => {
    expect(adaptUser({ ...WIRE_USER, display_name: null }).displayName).toBeNull();
    expect(adaptUser({ ...WIRE_USER, display_name: '  ' }).displayName).toBeNull();
  });

  it('refuses a user without id or email, or with a role this client does not know', () => {
    expect(() => adaptUser({ ...WIRE_USER, user_id: undefined } as unknown as WireUser)).toThrow(/can't show/);
    expect(() => adaptUser({ ...WIRE_USER, role: 'owner' } as unknown as WireUser)).toThrow(/role/);
  });
});

describe('health', () => {
  it('reads auth from the health answer; without it there is no sign-in', async () => {
    backend();
    expect((await createApiSource(BASE).health()).auth).toEqual({ enabled: true, registration: 'open' });
    backend((c) => (c.path === '/health' ? json(200, fixture('health-demo')) : undefined));
    expect((await createApiSource(BASE).health()).auth).toEqual({ enabled: false, registration: 'closed' });
  });
});

describe('the sign-in endpoints', () => {
  it('currentUser: GET /auth/me answers the user; a 401 means no session (null) and is no ended session', async () => {
    const { calls } = backend();
    const { api, ended } = source();
    expect(await api.currentUser()).toMatchObject({ email: WIRE_USER.email, role: 'admin' });
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/auth/me' });
    backend((c) => (c.path === '/auth/me' ? notAuthenticated() : undefined));
    expect(await api.currentUser()).toBeNull();
    expect(ended).not.toHaveBeenCalled();
  });

  it('currentUser: other failures are thrown (the boot shows them)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(createApiSource(BASE).currentUser()).rejects.toBeInstanceOf(UnreachableError);
  });

  it('signIn: POST /auth/login with the trimmed email and the password as typed', async () => {
    const { calls } = backend();
    const user = await source().api.signIn('  ada.reviewer@example.test ', ' fictional pass phrase ');
    expect(user.userId).toBe(WIRE_USER.user_id);
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/auth/login', body: { email: 'ada.reviewer@example.test', password: ' fictional pass phrase ' } });
  });

  it.each([
    [401, 'invalid_credentials'],
    [422, 'validation_error'],
    [429, 'rate_limited'],
  ])('signIn: %i %s is an ApiError with that code, never an ended session', async (status, code) => {
    backend((c) => (c.path === '/auth/login' ? error(status, code) : undefined));
    const { api, ended } = source();
    await expect(api.signIn('ada.reviewer@example.test', 'fictional-wrong')).rejects.toMatchObject({ status, code });
    expect(ended).not.toHaveBeenCalled();
  });

  it('a 429 carries the Retry-After wait in seconds', async () => {
    backend((c) => (c.path === '/auth/login' ? error(429, 'rate_limited', 'Slow down.', undefined, { 'retry-after': '120' }) : undefined));
    const e = await source().api.signIn('ada.reviewer@example.test', 'x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).retryAfter).toBe(120);
  });

  it('register: POST /auth/register; the display name only when one was typed', async () => {
    const { calls } = backend();
    const { api } = source();
    await api.register({ email: ' new@example.test ', password: 'fictional-long-passphrase', displayName: ' New Person ' });
    expect(calls.at(-1)).toEqual({
      method: 'POST', path: '/auth/register', body: { email: 'new@example.test', password: 'fictional-long-passphrase', display_name: 'New Person' },
    });
    await api.register({ email: 'new@example.test', password: 'fictional-long-passphrase', displayName: '   ' });
    expect(calls.at(-1)?.body).toEqual({ email: 'new@example.test', password: 'fictional-long-passphrase' });
    await api.register({ email: 'new@example.test', password: 'fictional-long-passphrase', displayName: null });
    expect(calls.at(-1)?.body).not.toHaveProperty('display_name');
  });

  it('register: 409 email_taken and 422 with field errors', async () => {
    backend((c) => (c.path === '/auth/register' ? error(409, 'email_taken') : undefined));
    await expect(source().api.register({ email: 'a@example.test', password: 'fictional-long-passphrase', displayName: null })).rejects.toMatchObject({
      status: 409, code: 'email_taken',
    });
    const fields = [{ loc: ['body', 'password'], msg: 'This password is too common.' }];
    backend((c) => (c.path === '/auth/register' ? error(422, 'validation_error', 'Invalid request.', fields) : undefined));
    await expect(source().api.register({ email: 'a@example.test', password: 'password1234', displayName: null })).rejects.toMatchObject({
      code: 'validation_error', errors: fields,
    });
  });

  it('signOut: POST /auth/logout (204)', async () => {
    const { calls } = backend();
    await source().api.signOut();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/auth/logout' });
  });

  it('changePassword: POST /auth/password; 401 invalid_credentials is an answer, not an ended session', async () => {
    const { calls } = backend();
    const { api, ended } = source();
    await api.changePassword('fictional-old-phrase', 'fictional-new-phrase');
    expect(calls.at(-1)).toEqual({
      method: 'POST', path: '/auth/password', body: { current_password: 'fictional-old-phrase', new_password: 'fictional-new-phrase' },
    });
    backend((c) => (c.path === '/auth/password' ? error(401, 'invalid_credentials') : undefined));
    await expect(api.changePassword('wrong', 'fictional-new-phrase')).rejects.toMatchObject({ code: 'invalid_credentials' });
    const fields = [{ loc: ['body', 'new_password'], msg: 'Too short.' }];
    backend((c) => (c.path === '/auth/password' ? error(422, 'validation_error', 'Invalid request.', fields) : undefined));
    await expect(api.changePassword('fictional-old-phrase', 'short')).rejects.toMatchObject({ errors: fields });
    expect(ended).not.toHaveBeenCalled();
  });
});

describe('the session listener', () => {
  it('fires once for a burst of 401 not_authenticated answers of normal requests', async () => {
    backend((c) => (c.path !== '/auth/login' && c.path !== '/health' ? notAuthenticated() : undefined));
    const { api, ended } = source();
    // The boot's three lists all answer 401: one ended session.
    await expect(api.load()).rejects.toMatchObject({ code: 'not_authenticated' });
    await expect(api.getDocument('doc_x')).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(ended).toHaveBeenCalledTimes(1);
    // After a sign-in the next 401 is a new ended session.
    await api.signIn('ada.reviewer@example.test', 'fictional-pass-phrase');
    await expect(api.getDocument('doc_x')).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it('never fires for the sign-in endpoints, whose 401 is an answer', async () => {
    backend((c) => (c.path.startsWith('/auth/') ? notAuthenticated() : undefined));
    const { api, ended } = source();
    expect(await api.currentUser()).toBeNull();
    await expect(api.signIn('a@example.test', 'x')).rejects.toBeInstanceOf(ApiError);
    await expect(api.register({ email: 'a@example.test', password: 'fictional-long-passphrase', displayName: null })).rejects.toBeInstanceOf(ApiError);
    await expect(api.changePassword('a', 'fictional-long-passphrase')).rejects.toBeInstanceOf(ApiError);
    await expect(api.signOut()).rejects.toBeInstanceOf(ApiError);
    expect(ended).not.toHaveBeenCalled();
    expect(['/auth/login', '/auth/register', '/auth/password', '/auth/me'].map((p) => endsSession(p, new ApiError(401, 'not_authenticated', '')))).toEqual([
      false, false, false, false,
    ]);
    expect(endsSession('/documents?x=1', new ApiError(401, 'not_authenticated', ''))).toBe(true);
    // Other 401 codes and other statuses are no ended session.
    expect(endsSession('/documents', new ApiError(401, 'invalid_credentials', ''))).toBe(false);
    expect(endsSession('/documents', new ApiError(403, 'not_authenticated', ''))).toBe(false);
  });

  it('stays quiet after signing out (the store already shows the sign-in)', async () => {
    backend((c) => (c.path === '/documents' ? notAuthenticated() : undefined));
    const { api, ended } = source();
    await api.signIn('ada.reviewer@example.test', 'fictional-pass-phrase');
    await api.signOut();
    await expect(api.load()).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(ended).not.toHaveBeenCalled();
  });

  it('a 401 of a request sent before the latest sign-in is about the old session: not reported again', async () => {
    let answerLate!: (r: Response) => void;
    backend((c) => (c.path === '/documents/doc_late' ? new Promise<Response>((r) => (answerLate = r)) : undefined));
    const { api, ended } = source();
    const late = api.getDocument('doc_late');
    await api.signIn('ada.reviewer@example.test', 'fictional-pass-phrase');
    answerLate(notAuthenticated());
    await expect(late).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(ended).not.toHaveBeenCalled();
  });

  it('removing the listener (null) stops the calls', async () => {
    backend((c) => (c.path === '/documents' ? notAuthenticated() : undefined));
    const { api, ended } = source();
    api.setSessionListener(null);
    await expect(api.load()).rejects.toBeInstanceOf(ApiError);
    expect(ended).not.toHaveBeenCalled();
  });

  it('fires for a 401 not_authenticated answer of the XHR upload', async () => {
    backend();
    vi.stubGlobal('XMLHttpRequest', MockXhr);
    const { api, ended } = source();
    const handle = api.upload(new File([new Uint8Array(3)], 'fictional.pdf'), { project: null });
    MockXhr.last.respondJson(401, { detail: 'Sign in first.', code: 'not_authenticated' });
    await expect(handle.done).rejects.toMatchObject({ status: 401, code: 'not_authenticated' });
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe('live events with sign-in on', () => {
  beforeEach(() => vi.stubGlobal('EventSource', MockEventSource));

  it('a failing stream checks the session (GET /auth/me); its 401 ends the session and the stream is not reopened', async () => {
    vi.useFakeTimers();
    let signedIn = true;
    const { calls } = backend((c) => (c.path === '/auth/me' && !signedIn ? notAuthenticated() : undefined));
    const { api, ended } = source();
    await api.health();
    const unsubscribe = api.subscribe(() => undefined, () => undefined);
    const es = MockEventSource.last;
    es.open();
    // The server restarts while the session is fine: one check, no ended session.
    es.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.path === '/auth/me')).toHaveLength(1);
    expect(ended).not.toHaveBeenCalled();
    // The session ends: the stream fails for good (the server answers 401, the browser closes it).
    signedIn = false;
    es.error(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toHaveBeenCalledTimes(1);
    // Without a session the stream is not opened again.
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS * 4);
    expect(MockEventSource.instances).toHaveLength(1);
    unsubscribe();
  });

  it('without sign-in a failing stream checks nothing', async () => {
    vi.useFakeTimers();
    const { calls } = backend((c) => (c.path === '/health' ? json(200, fixture('health-demo')) : undefined));
    const { api } = source();
    await api.health();
    const unsubscribe = api.subscribe(() => undefined, () => undefined);
    MockEventSource.last.error(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.path === '/auth/me')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    expect(MockEventSource.instances).toHaveLength(2);
    unsubscribe();
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds or an HTTP date; anything else is unknown', () => {
    expect(parseRetryAfter('90')).toBe(90);
    expect(parseRetryAfter(' 0 ')).toBe(0);
    const now = Date.parse('2026-10-17T08:00:00Z');
    expect(parseRetryAfter('Sat, 17 Oct 2026 08:05:00 GMT', now)).toBe(300);
    expect(parseRetryAfter('Sat, 17 Oct 2026 07:55:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});
