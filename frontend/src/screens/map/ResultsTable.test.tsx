/**
 * RESULTS table, server-rendered (fictional boreholes): columns, the announced count, sortable headers
 * with aria-sort, pages of 100 rows, the selected row, the keyboard and map actions, and the CRS
 * column rules.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '../../domain/types';
import { featureOf } from '../../store/testing';
import { makeBorehole, makeDocument, makeValue } from '../../test/fixtures';
import { allRows, type ResultRow, type Sort } from './explore/resultsModel';
import { ResultsTableView, type ResultsTableViewProps } from './ResultsTable';

const noop = () => undefined;
const DOC = makeDocument({ id: 'doc_TEST_A', name: 'alpha_report.pdf' });

function render(rows: ResultRow[], o: Partial<ResultsTableViewProps> = {}): string {
  const props: ResultsTableViewProps = {
    rows, page: 0, sort: null, selectedUid: null, summary: `${rows.length} boreholes`,
    onSort: noop, onPage: noop, onOpen: noop, onShow: noop, ...o,
  };
  return renderToStaticMarkup(<ResultsTableView {...props} />);
}

/** The rows of the table, each from its opening tag to the next row (the last one to the end). */
const bodyRows = (html: string) => html.split(/(?=<div[^>]*role="row"[^>]*data-uid=)/).slice(1);
/** The cells' text of a row. */
const cellTexts = (row: string) => [...row.matchAll(/role="cell"[^>]*>(.*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));

const pin = (o: Parameters<typeof makeBorehole>[0]) => featureOf(makeBorehole({ documentId: DOC.id, ...o })) as MapFeature;

describe('ResultsTableView', () => {
  it('uiv-9: announces the count in a polite live region', () => {
    const html = render([], { summary: '2 boreholes · 1 project' });
    expect(html).toMatch(/<div[^>]*aria-live="polite"[^>]*>2 boreholes · 1 project<\/div>/);
  });

  it('columns: borehole, project, depth, status, CRS, document, then the actions', () => {
    const rows = allRows([pin({ uid: 'bh_A', id: 'TB-01', finalDepth: 12.5 })], [], [], [DOC]);
    const html = render(rows);
    const headers = [...html.matchAll(/role="columnheader"[^>]*>(.*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
    expect(headers).toEqual(['BOREHOLE', 'PROJECT', 'FINAL DEPTH', 'STATUS', 'CRS', 'DOCUMENT', '']);
    const [row] = bodyRows(html);
    expect(cellTexts(row)).toEqual(['TB-01', 'Test Project (fictional)', '12.50 m', 'Unreviewed', 'stated', 'alpha_report.pdf', 'MAPOPEN DETAIL ›']);
  });

  it('a depth that is not stated says so, never 0; attention wins over the server status', () => {
    const flagged = makeBorehole({ uid: 'bh_F', id: 'TB-F', finalDepth: null, reviewStatus: 'approved', onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' });
    flagged.values = [makeValue({ key: 'x', status: 'flagged', flag: 'check' })];
    const html = render(allRows([], [flagged], [flagged.uid], []));
    expect(cellTexts(bodyRows(html)[0]).slice(2, 4)).toEqual(['not stated', 'Needs attention']);
  });

  it('a row is focusable and says how to use it; a plotted row has a map button, an unplotted one does not', () => {
    const off = makeBorehole({ uid: 'bh_OFF', id: 'TB-OFF', onMap: false, lat: null, lng: null, unplottedReason: 'crs_unknown' });
    const html = render(allRows([pin({ uid: 'bh_A', id: 'TB-01' })], [off], [off.uid], [DOC]));
    const [plotted, unplotted] = bodyRows(html);
    expect(plotted).toMatch(/role="row"[^>]*tabindex="0"/i);
    expect(plotted).toContain('aria-describedby="results-keys"');
    expect(plotted).toMatch(/<button type="button"[^>]*aria-label="Show TB-01 on the map"[^>]*>MAP<\/button>/);
    expect(unplotted).not.toContain('<button');
    expect(unplotted).toContain('not on map');
    expect(html).toMatch(/id="results-keys"[^>]*>Enter opens the detail\. Space shows the borehole on the map\. Arrow keys move between rows\.</);
  });

  it('the selected borehole’s row is marked current', () => {
    const rows = allRows([pin({ uid: 'bh_A', id: 'TB-01' }), pin({ uid: 'bh_B', id: 'TB-02' })], [], [], [DOC]);
    const [a, b] = bodyRows(render(rows, { selectedUid: 'bh_B' }));
    expect(a).not.toContain('aria-current');
    expect(b).toContain('aria-current="true"');
  });

  it('headers are sort buttons; the sorted column has aria-sort, the others none', () => {
    const rows = allRows([pin({ uid: 'bh_A', id: 'TB-01' })], [], [], [DOC]);
    const sort: Sort = { key: 'depth', dir: 'desc' };
    const html = render(rows, { sort });
    expect(html).toMatch(/role="columnheader" aria-sort="descending"[^>]*><button type="button"[^>]*>FINAL DEPTH/);
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
    expect(html).toMatch(/role="columnheader"><button type="button"[^>]*>BOREHOLE<\/button>/);
    expect(render(rows, { sort: { key: 'id', dir: 'asc' } })).toMatch(/role="columnheader" aria-sort="ascending"[^>]*><button[^>]*>BOREHOLE/);
  });

  it('pages of 100 rows with the range and page buttons; one page has no pager', () => {
    const many = Array.from({ length: 250 }, (_, i) => pin({ uid: `bh_${i}`, id: `TB-${i}` }));
    const rows = allRows(many, [], [], [DOC]);
    const first = render(rows, { page: 0 });
    expect(bodyRows(first)).toHaveLength(100);
    expect(first).toMatch(/<nav[^>]*aria-label="Result pages"/);
    expect(first).toContain('Rows 1–100 of 250');
    expect(first).toMatch(/<button type="button"[^>]*disabled=""[^>]*>‹ PREVIOUS<\/button>/);
    expect(first).toContain('Page 1 of 3');
    const last = render(rows, { page: 2 });
    expect(bodyRows(last)).toHaveLength(50);
    expect(last).toContain('Rows 201–250 of 250');
    expect(last).toMatch(/<button type="button"[^>]*disabled=""[^>]*>NEXT ›<\/button>/);
    // Rows carry their position in the whole list.
    expect(bodyRows(last)[0]).toContain('aria-rowindex="202"');
    expect(render(rows.slice(0, 3))).not.toContain('Result pages');
  });

  it('an empty table says why: nothing uploaded, or nothing in the result set', () => {
    expect(render([])).toContain('No boreholes yet. Upload a report under UPLOAD &amp; QUEUE.');
    expect(render([], { empty: 'No borehole matches.' })).toContain('No borehole matches.');
  });
});

describe('CRS column', () => {
  it('a confirmed CRS of a cached record shows its code after the status, with a title that names it', () => {
    const b = makeBorehole({ uid: 'bh_C', crs: { name: null, code: 'EPSG:2193', status: 'confirmed' } });
    const html = render(allRows([featureOf(b)!], [b], [], []));
    expect(html).toMatch(/role="cell" title="Coordinate system confirmed by a reviewer: EPSG:2193">confirmed · EPSG:2193</);
  });

  it('a pin without its record shows the status only, and never claims there is no system', () => {
    const b = makeBorehole({ uid: 'bh_C', crs: { name: null, code: 'EPSG:2193', status: 'confirmed' } });
    const html = render(allRows([featureOf(b)!], [], [], []));
    expect(html).toMatch(/role="cell" title="Coordinate system confirmed by a reviewer">confirmed</);
    expect(html).not.toContain('No coordinate system');
  });
});
