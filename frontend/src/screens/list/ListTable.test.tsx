/** LIST's table, server-rendered (fictional boreholes): columns, NOT ON MAP, empty texts, actions. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '../../domain/types';
import { featureOf } from '../../store/testing';
import { makeBorehole, makeDocument } from '../../test/fixtures';
import { allRows, type ResultRow } from '../map/explore/resultsModel';
import { ListTable, NO_BOREHOLES } from './ListTable';

const noop = () => undefined;
const DOC = makeDocument({ id: 'doc_TEST_A', name: 'alpha_report.pdf' });
const off = makeBorehole({ uid: 'bh_C', id: 'TB-03', documentId: DOC.id, onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' });

function render(rows: ResultRow[], empty = NO_BOREHOLES): string {
  return renderToStaticMarkup(
    <ListTable
      rows={rows}
      records={new Map([[off.uid, off]])}
      recordState={() => 'loading'}
      selectedUid={null}
      pointed={null}
      resetKey="all"
      empty={empty}
      onVisible={noop}
      onOpen={noop}
      onShow={noop}
    />,
  );
}

describe('ListTable', () => {
  const pinned = featureOf(makeBorehole({ uid: 'bh_A', id: 'TB-01', documentId: DOC.id, finalDepth: 12.5 })) as MapFeature;
  const rows = allRows([pinned], [off], [off.uid], [DOC]);

  it('BOREHOLE, PROJECT, STATUS and the default columns FINAL DEPTH, CRS STATUS, CRS', () => {
    const html = render(rows);
    const heads = [...html.matchAll(/role="columnheader"[^>]*>(.*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace('×', ''));
    expect(heads.slice(0, 6)).toEqual(['BOREHOLE', 'PROJECT', 'STATUS', 'FINAL DEPTH', 'CRS STATUS', 'CRS']);
    expect(html).toContain('aria-label="Remove column FINAL DEPTH"');
    expect(html).toContain('12.50 m');
  });

  it('a borehole without a pin: NOT ON MAP with its reason, no MAP button, its detail named with the reason', () => {
    const html = render(rows);
    expect(html).toContain('NOT ON MAP · No coordinates in source');
    expect(html).toContain('aria-label="Show TB-01 on the map"');
    expect(html).not.toContain('aria-label="Show TB-03 on the map"');
    expect(html).toContain('aria-label="Open detail of TB-03: No coordinates in source"');
    expect(html).toMatch(/2 boreholes · 1 project<span[^>]*> · 1 not on the map<\/span>/);
  });

  it('empty: says why (nothing uploaded yet, or nothing matches)', () => {
    expect(render([])).toContain('No boreholes yet. Upload a report under UPLOAD &amp; QUEUE.');
    expect(render([], 'No borehole matches the search.')).toContain('No borehole matches the search.');
  });
});
