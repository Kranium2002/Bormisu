/** ScanPage: a named group (not an img) around its box buttons, and a reserved page shape while an image loads (F04, int-03). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PageContent } from '../domain/types';
import { ScanPage, type ScanBox } from './ScanPage';
import styles from './ScanPage.module.css';

const drawn: PageContent = {
  documentId: 'doc', page: 7, type: 'log', usage: 'used: borehole log', label: 'page 7 · report.pdf',
  items: [{ kind: 'text', x: 10, y: 10, text: 'BK-07' }],
};
const image: PageContent = { documentId: 'doc', page: 7, type: 'log', usage: 'used: borehole log', label: 'page 7 · report.pdf', imageUrl: '/api/v1/documents/doc/pages/7.png' };
const boxes: ScanBox[] = [{ id: 'fd', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, variant: 'focus', title: 'Final depth', onClick: () => undefined }];

/** The class list of the element that carries the page's aria-label. */
const pageClasses = (html: string) => html.match(/<div class="([^"]*)"[^>]*aria-label="page 7 · report.pdf"/)?.[1].split(/\s+/) ?? [];

describe('ScanPage', () => {
  it('draws a sample page as a named group that holds the box buttons, never role=img', () => {
    const html = renderToStaticMarkup(<ScanPage content={drawn} boxes={boxes} />);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="page 7 · report.pdf"');
    expect(html).not.toContain('role="img"');
    expect(html).toContain('aria-label="Final depth"');
  });

  it('reserves the 560:780 page shape while an API image loads, with the boxes on it', () => {
    const html = renderToStaticMarkup(<ScanPage content={image} boxes={boxes} scale={0.92} />);
    const classes = pageClasses(html);
    expect(styles.reserved).toBeTruthy();
    expect(classes).toContain(styles.imagePage);
    expect(classes).toContain(styles.reserved);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('src="/api/v1/documents/doc/pages/7.png"');
    expect(html).toContain('aria-label="Final depth"');
    expect(html).not.toContain('PAGE IMAGE NOT AVAILABLE');
  });

  it('keeps the drawn page unreserved: its frame has a fixed size', () => {
    expect(pageClasses(renderToStaticMarkup(<ScanPage content={drawn} />))).not.toContain(styles.reserved);
  });
});
