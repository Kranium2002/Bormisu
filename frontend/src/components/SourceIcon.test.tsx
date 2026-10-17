/** SourceIcon: a button when it can open the source, an inert image when it can't (F23). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourceIcon } from './SourceIcon';

describe('SourceIcon', () => {
  it('is a named button with the page glyph when it has onClick', () => {
    const html = renderToStaticMarkup(<SourceIcon onClick={() => undefined} title="Show source of Final depth" />);
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('aria-label="Show source of Final depth"');
    expect(html).toContain('title="Show source of Final depth"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).not.toContain('role="img"');
  });

  it('is a non-interactive image without onClick: no button, no tab stop', () => {
    const html = renderToStaticMarkup(<SourceIcon title="Source: page 7" />);
    expect(html).toMatch(/^<span /);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Source: page 7"');
    expect(html).toContain('title="Source: page 7"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('tabindex');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('defaults the name to "Show source"', () => {
    expect(renderToStaticMarkup(<SourceIcon onClick={() => undefined} />)).toContain('aria-label="Show source"');
    expect(renderToStaticMarkup(<SourceIcon />)).toContain('aria-label="Show source"');
  });
});
