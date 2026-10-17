/** F12: the INBOX link of the header with its count of unresolved questions (fictional questions). */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Header, inboxLinkLabel } from '../Header';
import { makeClarification } from './clarifyFixtures';
import { resetTestStore } from './testStore';

vi.mock('leaflet', () => ({}));
vi.mock('../../store/appStore', async (importOriginal) => (await import('./testStore')).mockAppStore(await importOriginal()));

const render = (path = '/map') =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Header />
    </MemoryRouter>,
  );

/** The opening tag of the INBOX link and its content. */
const inboxLink = (html: string) => html.match(/<a[^>]*href="\/inbox"[^>]*>.*?<\/a>/)?.[0] ?? '';

beforeEach(() => resetTestStore());

describe('INBOX link', () => {
  it('counts open and skipped questions, not answered ones; the count is in its accessible name', () => {
    resetTestStore({
      clarificationsState: 'ready',
      clarifications: [
        makeClarification({ id: 'cl_1' }),
        makeClarification({ id: 'cl_2', status: 'skipped' }),
        makeClarification({ id: 'cl_3' }),
        makeClarification({ id: 'cl_4', status: 'answered' }),
      ],
    });
    const link = inboxLink(render());
    expect(link).toContain('aria-label="INBOX, 3 unresolved questions"');
    expect(link).toMatch(/INBOX<span[^>]*aria-hidden="true">3<\/span><\/a>$/);
  });

  it('without questions: no badge, and the name says none', () => {
    resetTestStore({ clarificationsState: 'ready', clarifications: [] });
    const link = inboxLink(render());
    expect(link).toContain('aria-label="INBOX, no unresolved questions"');
    expect(link).not.toContain('<span');
  });

  it('is the current page on /inbox, also with a question open', () => {
    expect(inboxLink(render('/inbox?q=cl_1'))).toContain('aria-current="page"');
    expect(inboxLink(render('/map'))).not.toContain('aria-current');
  });

  it('has a polite live region for count changes, empty at first', () => {
    resetTestStore({ clarificationsState: 'ready', clarifications: [makeClarification()] });
    expect(render()).toMatch(/<span class="[^"]*srOnly[^"]*" aria-live="polite" aria-atomic="true"><\/span>/);
  });

  it('labels', () => {
    expect(inboxLinkLabel(1)).toBe('INBOX, 1 unresolved question');
    expect(inboxLinkLabel(0)).toBe('INBOX, no unresolved questions');
  });
});
