/** The result-set line above RESULTS, server-rendered (fictional counts): summary, busy, error, nothing active. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResultSetSummary, type ResultSetSummaryProps } from './ResultSetSummary';

const RS = { id: 'rs_TEST', count: 7, locatedCount: 6, unlocatedCount: 1, excludedUnreviewed: 2 };

const render = (o: Partial<ResultSetSummaryProps> = {}) =>
  renderToStaticMarkup(<ResultSetSummary resultSet={null} busy={false} error={null} onClear={() => undefined} {...o} />);

describe('ResultSetSummary', () => {
  it('an active set: its counts in a polite live region, its id, and CLEAR', () => {
    const html = render({ resultSet: RS });
    expect(html).toContain('data-result-set="rs_TEST"');
    expect(html).toMatch(/<p[^>]*aria-live="polite" aria-atomic="true">7 boreholes · 6 on the map · 1 not located · 2 unreviewed left out<\/p>/);
    expect(html).toMatch(/<button type="button"[^>]*aria-label="Clear the result set and the filters">CLEAR<\/button>/);
  });

  it('no set: the live region is there but empty, no CLEAR', () => {
    const html = render();
    expect(html).toMatch(/<p[^>]*aria-live="polite" aria-atomic="true"><\/p>/);
    expect(html).not.toContain('CLEAR');
    expect(html).not.toContain('data-result-set=');
  });

  it('busy while a set is asked for; a failure is an alert with the server’s detail', () => {
    expect(render({ busy: true })).toMatch(/aria-busy="true"[^>]*>.*Selecting boreholes…/);
    expect(render({ error: 'Result set not found or expired.' })).toMatch(/<p[^>]*role="alert">Result set not found or expired\.<\/p>/);
  });
});
