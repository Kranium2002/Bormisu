// @vitest-environment jsdom
/**
 * A scanned page (fictional pages): an uploaded page image draws its boxes only once it has loaded,
 * says it is loading the original scan until then, and says when it can't be loaded; a drawn sample
 * page draws them at once.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageContent } from '../domain/types';
import { ScanPage, type ScanBox } from './ScanPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

const DRAWN: PageContent = { documentId: 'doc_X', page: 6, type: 'log', usage: 'used', label: 'page 6 · fictional-report.pdf', items: [] };
const IMAGE: PageContent = { ...DRAWN, imageUrl: '/api/v1/documents/doc_X/pages/6.png' };
const BOXES: ScanBox[] = [{ id: 'v', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 }, variant: 'highlight', title: 'Final depth' }];

async function show(content: PageContent) {
  document.body.innerHTML = '<div id="app"></div>';
  root = createRoot(document.querySelector('#app')!);
  await act(async () => root!.render(<ScanPage content={content} boxes={BOXES} />));
}

const boxCount = () => document.querySelectorAll('[title="Final depth"]').length;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('ScanPage', () => {
  it('an uploaded page: no boxes and "Loading the original scan…" until the image has loaded', async () => {
    await show(IMAGE);
    expect(document.body.textContent).toContain('Loading the original scan… · page 6');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(boxCount()).toBe(0);
    await act(async () => document.querySelector('img')!.dispatchEvent(new Event('load')));
    expect(document.body.textContent).not.toContain('Loading the original scan');
    expect(boxCount()).toBe(1);
  });

  it('an uploaded page that fails: says so with the path, no image and no boxes', async () => {
    await show(IMAGE);
    await act(async () => document.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(document.body.textContent).toContain('Original page could not be loaded · page 6');
    expect(document.body.textContent).toContain('/api/v1/documents/doc_X/pages/6.png');
    expect(document.querySelector('img')).toBeNull();
    expect(boxCount()).toBe(0);
  });

  it('a drawn sample page draws its boxes at once', async () => {
    await show(DRAWN);
    expect(boxCount()).toBe(1);
    expect(document.body.textContent).not.toContain('Loading the original scan');
  });
});
