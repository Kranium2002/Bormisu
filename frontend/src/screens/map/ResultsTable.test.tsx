/** Server-rendered RESULTS table (fictional boreholes): status from displayStatus, CRS text, announced count. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeBorehole, makeValue } from '../../test/fixtures';
import { statusByUid } from './mapModel';
import { ResultsTable } from './ResultsTable';

const noop = () => undefined;

describe('ResultsTable', () => {
  it('uiv-9: announces the result count in a polite live region', () => {
    const bs = [makeBorehole(), makeBorehole({ uid: 'bh_TEST2', id: 'TB-02' })];
    const html = renderToStaticMarkup(<ResultsTable boreholes={bs} statuses={statusByUid(bs)} onOpen={noop} />);
    expect(html).toMatch(/<div[^>]*aria-live="polite"[^>]*>2 boreholes · 1 project<\/div>/);
  });

  it('shows attention over the server status and the CRS code when no system name was printed', () => {
    const flagged = makeBorehole({ reviewStatus: 'approved', crs: { name: null, code: 'EPSG:2193', status: 'confirmed' } });
    flagged.values = [makeValue({ key: 'x', status: 'flagged', flag: 'check' })];
    const html = renderToStaticMarkup(<ResultsTable boreholes={[flagged]} statuses={statusByUid([flagged])} onOpen={noop} />);
    expect(html).toContain('Needs attention');
    expect(html).toContain('confirmed · EPSG:2193');
  });
});
