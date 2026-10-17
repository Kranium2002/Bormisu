/** Server-rendered RESULTS table (fictional boreholes): status from the record or the pin, CRS text, announced count. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { featureOf } from '../../store/testing';
import { makeBorehole, makeValue } from '../../test/fixtures';
import { featureRow, recordRow } from './mapModel';
import { ResultsTable } from './ResultsTable';

const noop = () => undefined;

describe('ResultsTable', () => {
  it('uiv-9: announces the result count in a polite live region', () => {
    const rows = [makeBorehole(), makeBorehole({ uid: 'bh_TEST2', id: 'TB-02' })].map(recordRow);
    const html = renderToStaticMarkup(<ResultsTable rows={rows} onOpen={noop} />);
    expect(html).toMatch(/<div[^>]*aria-live="polite"[^>]*>2 boreholes · 1 project<\/div>/);
  });

  it('shows attention over the server status and the CRS code when no system name was printed', () => {
    const flagged = makeBorehole({ reviewStatus: 'approved', crs: { name: null, code: 'EPSG:2193', status: 'confirmed' } });
    flagged.values = [makeValue({ key: 'x', status: 'flagged', flag: 'check' })];
    const html = renderToStaticMarkup(<ResultsTable rows={[recordRow(flagged)]} onOpen={noop} />);
    expect(html).toContain('Needs attention');
    expect(html).toContain('confirmed · EPSG:2193');
  });

  it('a pin without its full record shows the map layer’s status, depth and CRS status', () => {
    const pin = { ...featureOf(makeBorehole({ finalDepth: 12.5 }))!, attention: true };
    const html = renderToStaticMarkup(<ResultsTable rows={[featureRow(pin)]} onOpen={noop} />);
    expect(html).toContain('Needs attention');
    expect(html).toContain('12.50 m');
    expect(html).toMatch(/>stated<\/div>/);
  });
});
