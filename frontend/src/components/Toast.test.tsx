/** The toast (server-rendered): its text, and a button when it carries an action (e.g. SHOW ON MAP). */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from './clarify/testStore';
import { Toast } from './Toast';

vi.mock('../store/appStore', async (importOriginal) => (await import('./clarify/testStore')).mockAppStore(await importOriginal()));

beforeEach(() => resetTestStore());

describe('Toast', () => {
  it('shows nothing without a toast', () => {
    expect(renderToStaticMarkup(<Toast />)).toBe('');
  });

  it('a plain toast is a polite status with its text', () => {
    resetTestStore({ toast: { id: 1, text: '2 clean values approved' } });
    const html = renderToStaticMarkup(<Toast />);
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(html).toContain('2 clean values approved');
    expect(html).not.toContain('<button');
  });

  it('a toast with an action carries its button', () => {
    resetTestStore({ toast: { id: 2, text: 'CRS confirmed · 3 boreholes placed', action: { label: 'SHOW ON MAP', run: () => undefined } } });
    const html = renderToStaticMarkup(<Toast />);
    expect(html).toContain('CRS confirmed · 3 boreholes placed');
    expect(html).toMatch(/<button type="button"[^>]*>SHOW ON MAP<\/button>/);
  });
});
