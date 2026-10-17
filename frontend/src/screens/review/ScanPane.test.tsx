/**
 * Server-rendered scan pane of the Review screen (fictional borehole): a borehole without pages.
 * Server rendering reads the store's initial state: no Review page chosen, no data source.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import { makeBorehole, makeValue } from '../../test/fixtures';
import { ScanPane } from './ScanPane';

describe('PRIMARY-PAGE-NULL: ScanPane', () => {
  it('a borehole without pages shows "No source page", no error and no page number', () => {
    const b = makeBorehole({
      pages: [],
      primaryPage: null,
      values: [makeValue({ key: K.country, label: 'Country', page: null, method: 'Guessed' })],
    });
    const html = renderToStaticMarkup(<ScanPane b={b} />);
    expect(html).toContain('No source page for this borehole.');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('null');
    expect(html).not.toMatch(/page 1\b/);
  });
});
