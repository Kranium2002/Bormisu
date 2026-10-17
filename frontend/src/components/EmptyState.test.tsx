/** withInlineCode: commands and API paths in an error message render as <code> (S12). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState, withInlineCode } from './EmptyState';

const html = (text: string) => renderToStaticMarkup(<>{withInlineCode(text)}</>);
const codes = (markup: string) => [...markup.matchAll(/<code[^>]*>([^<]*)<\/code>/g)].map((m) => m[1]);

describe('withInlineCode', () => {
  it('wraps npm run scripts and /api paths, and leaves sentence punctuation outside', () => {
    const out = html('Cannot reach the Bormisu backend at /api/v1. Start the backend, or run npm run dev:sample for demo data.');
    expect(codes(out)).toEqual(['/api/v1', 'npm run dev:sample']);
    expect(out.replace(/<[^>]+>/g, '')).toBe(
      'Cannot reach the Bormisu backend at /api/v1. Start the backend, or run npm run dev:sample for demo data.',
    );
  });

  it('keeps the whole path of a missing endpoint', () => {
    expect(codes(html('Backend endpoint not available: GET /api/v1/documents'))).toEqual(['/api/v1/documents']);
    expect(codes(html('Missing: /api/v1/boreholes/{uid}/values, see the contract.'))).toEqual(['/api/v1/boreholes/{uid}/values']);
  });

  it('returns plain text unchanged', () => {
    expect(withInlineCode('Loading failed.')).toBe('Loading failed.');
    expect(withInlineCode('the apiary at /apiary')).toBe('the apiary at /apiary');
  });

  it('wraps a command at the very start', () => {
    expect(codes(html('npm run dev starts API mode.'))).toEqual(['npm run dev']);
  });
});

describe('EmptyState', () => {
  it('is an alert with the message and a RETRY button in the error tone', () => {
    const out = renderToStaticMarkup(
      <EmptyState tone="error" title="NO DATA FROM THE BACKEND" message={withInlineCode('Run npm run dev:sample.')} action={{ label: 'RETRY', onClick: () => undefined }} />,
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain('NO DATA FROM THE BACKEND');
    expect(codes(out)).toEqual(['npm run dev:sample']);
    expect(out).toMatch(/<button type="button"[^>]*>RETRY<\/button>/);
  });
});
