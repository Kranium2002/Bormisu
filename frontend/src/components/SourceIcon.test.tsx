/** Server-rendered source icon: a control without an action is disabled with its reason (uiv-10). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourceIcon } from './SourceIcon';

describe('SourceIcon', () => {
  it('opens the source when it has an action', () => {
    const html = renderToStaticMarkup(<SourceIcon onClick={() => undefined} />);
    expect(html).not.toContain('disabled');
    expect(html).toContain('aria-label="Show source"');
  });

  it('is disabled, with the reason as its name, when there is nothing to open', () => {
    const html = renderToStaticMarkup(<SourceIcon dim title="Nothing printed to show" />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Nothing printed to show"');
  });
});
