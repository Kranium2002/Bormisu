/** PLANNED LINE, server-rendered (fictional values): the table by chainage, the empty state, the notes, German. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AlignmentHit } from '../../../domain/types';
import { translate } from '../../../i18n';
import { HitTable, LineNotes, PlannedLinePanel } from './PlannedLinePanel';

const hit = (uid: string, id: string, chainageM: number, offsetM: number, side: AlignmentHit['side']): AlignmentHit => ({
  uid,
  id,
  documentId: 'doc_TEST',
  project: null,
  depth: id === 'KB-1' ? 18 : null,
  reviewStatus: id === 'KB-1' ? 'in_review' : 'unreviewed',
  crsStatus: 'stated',
  lat: 50.21,
  lng: 9.42,
  offsetM,
  chainageM,
  side,
});

const KB1 = hit('bh_TEST_KB1', 'KB-1', 589.1, 39.8, 'left');
const KB3 = hit('bh_TEST_KB3', 'KB-3', 987.1, 72.7, 'right');

describe('HitTable', () => {
  it('one row per hit by chainage: name, chainage, offset, side, depth (blank when not stated), status, DETAIL ›', () => {
    const html = renderToStaticMarkup(<HitTable hits={[KB1, KB3]} bufferM={100} selectedUid={KB3.uid} />);
    expect(html).toContain('aria-label="Boreholes along the line"');
    for (const head of ['BOREHOLE', 'CHAINAGE', 'OFFSET', 'SIDE', 'DEPTH', 'STATUS']) expect(html).toContain(`>${head}</th>`);
    const rows = [...html.matchAll(/<tr[^>]*data-uid="([^"]+)"[^>]*>(.*?)<\/tr>/g)];
    expect(rows.map((r) => r[1])).toEqual([KB1.uid, KB3.uid]);
    expect(rows[0][2]).toMatch(/KB-1.*589 m.*39\.8 m.*Left.*18\.00 m.*In review.*DETAIL ›/);
    expect(rows[1][2]).toMatch(/KB-3.*987 m.*72\.7 m.*Right.*<td[^>]*><\/td>.*Unreviewed/);
    expect(rows[1][0]).toContain('aria-selected="true"');
  });

  it('DETAIL › sits in the pinned last column, so it stays visible while the table scrolls sideways', () => {
    const html = renderToStaticMarkup(<HitTable hits={[KB1, KB3]} bufferM={100} selectedUid={null} />);
    const cells = [...html.matchAll(/<t[hd][^>]*class="([^"]*)"[^>]*>(?:(?!<\/t[hd]>).)*<\/t[hd]>(?=<\/tr>)/g)];
    // The last cell of the header row and of both hit rows.
    expect(cells).toHaveLength(3);
    for (const [, cls] of cells) expect(cls).toContain('openCell');
    expect(cells.slice(1).every(([cell]) => cell.includes('DETAIL ›'))).toBe(true);
  });

  it('no hits: "No boreholes within 100 m"', () => {
    const html = renderToStaticMarkup(<HitTable hits={[]} bufferM={100} selectedUid={null} />);
    expect(html).toContain('No boreholes within 100 m');
    expect(html).not.toContain('<table');
  });

  it('German (texts keyed by the English wording)', () => {
    expect(translate('de', 'CHAINAGE')).toBe('STATION');
    expect(translate('de', 'Left')).toBe('Links');
    expect(translate('de', 'No boreholes within')).toBe('Keine Bohrungen innerhalb von');
    expect(translate('de', 'PLANNED LINE')).toBe('GEPLANTE TRASSE');
  });
});

describe('LineNotes', () => {
  it('the hidden unreviewed boreholes and those that cannot be checked; nothing when both are 0', () => {
    const html = renderToStaticMarkup(<LineNotes excludedUnreviewed={2} notOnMap={6} />);
    expect(html).toContain('2 unreviewed boreholes inside the band are hidden — turn on Include unreviewed');
    expect(html).toContain('6 boreholes are not on the map and cannot be checked against the line');
    expect(renderToStaticMarkup(<LineNotes excludedUnreviewed={1} notOnMap={1} />)).toContain('1 unreviewed borehole inside the band is hidden');
    expect(renderToStaticMarkup(<LineNotes excludedUnreviewed={0} notOnMap={0} />)).toBe('');
  });

  it('German', () => {
    expect(translate('de', 'unreviewed boreholes inside the band are hidden')).toBe('ungeprüfte Bohrungen im Korridor sind ausgeblendet');
    expect(translate('de', 'turn on Include unreviewed')).toBe('„Ungeprüfte einbeziehen“ einschalten');
    expect(translate('de', 'boreholes are not on the map and cannot be checked against the line')).toMatch(/^Bohrungen sind nicht auf der Karte/);
  });
});

describe('PlannedLinePanel', () => {
  it('without a line: the drop zone, CHOOSE FILE (line files only) and DRAW LINE', () => {
    const html = renderToStaticMarkup(<PlannedLinePanel open onClose={() => undefined} />);
    expect(html).toContain('id="planned-line-panel"');
    expect(html).toContain('accept=".geojson,.json,.kml,.gpx,.csv"');
    expect(html).toContain('>CHOOSE FILE</button>');
    expect(html).toContain('aria-pressed="false">DRAW LINE</button>');
    expect(html).not.toContain('planned-line-table');
  });
});
