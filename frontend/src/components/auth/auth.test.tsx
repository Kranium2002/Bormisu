/**
 * Sign-in UI (contract 1.3.0), server-rendered with a mocked store (fictional accounts only): the
 * form rules, the sign-in and create-account forms (fields, autocomplete, rules, errors, modes), the
 * gate, the user menu and the change-password dialog. Typing, Enter and the focus are covered by the
 * e2e spec e2e/api/auth.spec.ts.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_NAME } from '../../config';
import type { User } from '../../domain/types';
import { makeHealth } from '../../store/testing';
import { SESSION_ENDED } from '../../store/authSlice';
import { resetTestStore } from '../clarify/testStore';
import { UserMenu, userLabel } from '../header/UserMenu';
import { AuthGate } from './AuthGate';
import {
  PASSWORD_RULES,
  normaliseEmail,
  validateRegister,
  validateSignIn,
} from './authRules';
import { SignInScreen } from './SignInScreen';

vi.mock('leaflet', () => ({}));
vi.mock('../../store/appStore', async (importOriginal) => (await import('../clarify/testStore')).mockAppStore(await importOriginal()));

const USER: User = {
  userId: 'usr_TEST_000000000000000001',
  email: 'ada.reviewer@example.test',
  displayName: 'Ada Reviewer',
  role: 'admin',
  createdAt: '2026-10-17T07:00:00Z',
};
const OPEN = makeHealth({ auth: { enabled: true, registration: 'open' } });
const CLOSED = makeHealth({ auth: { enabled: true, registration: 'closed' } });

beforeEach(() => resetTestStore());

/** The <input> tag with this name attribute. */
const inputTag = (html: string, name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';

describe('form rules', () => {
  it('sign-in needs an email address and a password', () => {
    expect(validateSignIn('', '')).toEqual({ email: 'Enter your email.', password: 'Enter your password.' });
    expect(validateSignIn('not-an-email', 'x')).toEqual({ email: 'Enter an email address such as name@example.com.' });
    expect(validateSignIn(' ada.reviewer@example.test ', 'x')).toEqual({});
    expect(validateSignIn(`${'a'.repeat(250)}@example.test`, 'x').email).toBe('At most 254 characters.');
  });

  it('a new password: 8 to 128 characters, repeated', () => {
    const ok = { email: 'new@example.test', displayName: '', password: 'fictional-long-passphrase', repeat: 'fictional-long-passphrase' };
    expect(validateRegister(ok)).toEqual({});
    expect(validateRegister({ ...ok, password: 'short', repeat: 'short' }).password).toBe('Use at least 8 characters.');
    expect(validateRegister({ ...ok, password: '8chars!!', repeat: '8chars!!' })).toEqual({});
    expect(validateRegister({ ...ok, password: 'x'.repeat(129), repeat: 'x'.repeat(129) }).password).toBe('Use at most 128 characters.');
    expect(validateRegister({ ...ok, repeat: 'something else' })).toEqual({ repeat: 'The passwords do not match.' });
    expect(validateRegister({ ...ok, displayName: 'n'.repeat(81) })).toEqual({ display_name: 'At most 80 characters.' });
    expect(validateRegister({ ...ok, displayName: 'n'.repeat(80) })).toEqual({});
    expect(normaliseEmail('  Ada.Reviewer@Example.TEST ')).toBe('ada.reviewer@example.test');
  });
});

describe('SignInScreen', () => {
  it('signs in: the product name, email and password with their autocomplete, a show-password toggle', () => {
    resetTestStore({ authState: 'signedOut', health: CLOSED });
    const html = renderToStaticMarkup(<SignInScreen />);
    expect(html).toContain(`>${APP_NAME}</h1>`);
    expect(html).toContain('>SIGN IN</h2>');
    expect(inputTag(html, 'email')).toMatch(/type="email"/);
    expect(inputTag(html, 'email')).toMatch(/autoComplete="email"/);
    expect(inputTag(html, 'password')).toMatch(/type="password"/);
    expect(inputTag(html, 'password')).toMatch(/autoComplete="current-password"/);
    expect(html).toContain('aria-label="Show password"');
    expect(html).toMatch(/<button type="submit"[^>]*>SIGN IN<\/button>/);
    // Registration closed: no way to create an account, no alert.
    expect(html).not.toContain('Create an account');
    expect(html).not.toContain('role="alert"');
  });

  it('offers CREATE ACCOUNT when the server keeps registration open', () => {
    resetTestStore({ authState: 'signedOut', health: OPEN });
    expect(renderToStaticMarkup(<SignInScreen />)).toContain('>Create an account</button>');
  });

  it('create account: email, optional display name, new password with the rules, repeat', () => {
    resetTestStore({ authState: 'signedOut', health: OPEN });
    const html = renderToStaticMarkup(<SignInScreen initialMode="register" />);
    expect(html).toContain('>CREATE ACCOUNT</h2>');
    expect(inputTag(html, 'display_name')).toMatch(/autoComplete="name"/);
    expect(html).toContain('Optional. Shown with your reviews.');
    expect(inputTag(html, 'password')).toMatch(/autoComplete="new-password"/);
    expect(inputTag(html, 'repeat')).toMatch(/autoComplete="new-password"/);
    for (const rule of PASSWORD_RULES) expect(html).toContain(`<li>${rule}</li>`);
    expect(html).toContain('aria-label="Show repeat password"');
    expect(html).toContain('>Sign in</button>');
  });

  it('create account is not offered while registration is closed, even when asked for', () => {
    resetTestStore({ authState: 'signedOut', health: CLOSED });
    const html = renderToStaticMarkup(<SignInScreen initialMode="register" />);
    expect(html).toContain('>SIGN IN</h2>');
    expect(html).not.toContain('name="display_name"');
  });

  it('shows the error on top (role=alert) and the field errors next to their fields', () => {
    resetTestStore({
      authState: 'signedOut',
      health: OPEN,
      authError: 'Check the fields marked below.',
      authFieldErrors: { password: 'This password is too common.' },
    });
    const html = renderToStaticMarkup(<SignInScreen initialMode="register" />);
    expect(html).toMatch(/role="alert"[^>]*>Check the fields marked below.<\/div>/);
    const password = inputTag(html, 'password');
    expect(password).toContain('aria-invalid="true"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(password)?.[1].split(' ') ?? [];
    const errorId = describedBy.find((id) => id.endsWith('-error'));
    expect(errorId).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${errorId}" class="[^"]*fieldError[^"]*">This password is too common.</div>`));
    expect(inputTag(html, 'email')).not.toContain('aria-invalid');
  });

  it('says when the session ended', () => {
    resetTestStore({ authState: 'signedOut', health: OPEN, authError: SESSION_ENDED });
    const html = renderToStaticMarkup(<SignInScreen />);
    expect(html).toMatch(/role="alert" class="[^"]*alert[^"]* [^"]*notice[^"]*">Your session ended. Sign in again.<\/div>/);
  });

  it('is busy while a request runs: the button says so and is disabled, the fields keep their focus', () => {
    resetTestStore({ authState: 'signedOut', health: OPEN, authBusy: true });
    const html = renderToStaticMarkup(<SignInScreen />);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>SIGNING IN…<\/button>/);
    expect(html).toContain('aria-busy="true"');
    expect(inputTag(html, 'email')).toContain('readOnly=""');
    expect(inputTag(html, 'email')).not.toContain('disabled');
  });
});

describe('AuthGate', () => {
  const render = () => renderToStaticMarkup(<AuthGate><p>the app</p></AuthGate>);

  it('shows the app without sign-in and when signed in', () => {
    resetTestStore({ authState: 'disabled' });
    expect(render()).toBe('<p>the app</p>');
    resetTestStore({ authState: 'signedIn', user: USER });
    expect(render()).toBe('<p>the app</p>');
  });

  it('a centred loading state while the session is checked; the app when the boot failed (RETRY)', () => {
    resetTestStore({ authState: 'unknown', loadState: 'loading' });
    expect(render()).toMatch(/role="status"[^>]*>LOADING…<\/div>/);
    resetTestStore({ authState: 'unknown', loadState: 'error' });
    expect(render()).toBe('<p>the app</p>');
  });

  it('the sign-in instead of the app when signed out', () => {
    resetTestStore({ authState: 'signedOut', health: OPEN });
    const html = render();
    expect(html).not.toContain('the app');
    expect(html).toContain('>SIGN IN</h2>');
  });
});

describe('UserMenu', () => {
  it('signed in: a button with the display name, the email in its title', () => {
    resetTestStore({ authState: 'signedIn', user: USER });
    const html = renderToStaticMarkup(<UserMenu />);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog" aria-expanded="false" title="Signed in as ada.reviewer@example.test"[^>]*>Ada Reviewer<\/button>/);
    expect(html).not.toContain('YOUR NAME');
  });

  it('without a display name the button shows the email', () => {
    expect(userLabel({ ...USER, displayName: null })).toBe(USER.email);
    resetTestStore({ authState: 'signedIn', user: { ...USER, displayName: null } });
    expect(renderToStaticMarkup(<UserMenu />)).toContain('>ada.reviewer@example.test</button>');
  });

  it('without sign-in: the optional "Your name" setting as before; nothing while unknown', () => {
    resetTestStore({ authState: 'disabled' });
    expect(renderToStaticMarkup(<UserMenu />)).toContain('>YOUR NAME</button>');
    resetTestStore({ authState: 'unknown' });
    expect(renderToStaticMarkup(<UserMenu />)).toBe('');
  });
});

describe('contrast of the sign-in colours (at least 4.5:1)', () => {
  const builtin = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }).process.getBuiltinModule;
  const { readFileSync } = builtin('node:fs') as { readFileSync(p: URL, e: 'utf8'): string };
  const css = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8');
  const token = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1] as string;
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(token(a)), lum(token(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it.each([
    ['--c-text', '--c-surface', 'labels and inputs'],
    ['--c-muted', '--c-surface', 'hints and password rules'],
    ['--c-red', '--c-surface', 'field errors'],
    ['--c-text', '--c-red-bg', 'the error on top'],
    ['--c-text', '--c-amber-bg', 'the session-ended notice'],
    ['--c-on-green', '--c-green', 'the primary button'],
    ['--c-dark', '--c-surface', 'the mode switch link and the product name'],
    ['--c-text', '--c-line', 'a read-only field and the show-password toggle'],
  ])('%s on %s (%s)', (fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
