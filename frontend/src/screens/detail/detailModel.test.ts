import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import type { Borehole, Spt } from '../../domain/types';
import { exportScope } from '../../export/scope';
import { makeBorehole, makeLayer, makeValue } from '../../test/fixtures';
import {
  crsChip,
  excludedText,
  groundwaterRows,
  layerLint,
  layerRows,
  locationInfo,
  metadataRows,
  reviewedText,
  shortCrsName,
  shown,
  sourceLink,
  unreviewedCount,
} from './detailModel';

const REFUSAL: Spt = { raw: '50/30', depth: 10.5, refusal: true, blows: 50, penetrationCm: 30 };
const BAD_N: Spt = { raw: '3,4,5 = 8', depth: 1.5, refusal: false, increments: [3, 4, 5], n: 8 };

/** TB-01 with a short log (ends 14.50, final depth 18.00) on two sheets, an SPT refusal and a lint. */
function shortLog(): Borehole {
  const b = makeBorehole({
    finalDepth: 18,
    logBottom: 14.5,
    rockHead: 11.2,
    layers: [
      makeLayer({ n: 1, from: 0, to: 8.2, spt: BAD_N }),
      makeLayer({ n: 2, from: 8.2, to: 14.5, spt: REFUSAL, lithologyAsPrinted: 'Kies, sandig' }),
    ],
  });
  b.values = [
    makeValue({ key: K.finalDepth, value: '18.00', unit: 'm', lint: { severity: 'error', message: 'Log bottom 14.50 m ≠ final depth 18.00 m' } }),
    makeValue({ key: K.rockHead, value: '11.20', unit: 'm', method: 'Derived', formula: 'top of first rock layer (layer 2)' }),
    makeValue({ key: K.elevation, value: '241.35', unit: 'm NN' }),
    makeValue({ key: K.crs, value: 'ETRS89 / UTM zone 32N', kind: 'crs' }),
    makeValue({ key: K.notes, value: '', state: 'not in source', page: 7 }),
    makeValue({ key: K.gwStrike, group: 'groundwater', raw: 'GW 3,10', value: '3.10', unit: 'm bgl' }),
    makeValue({ key: K.lithology(1), group: 'layer', layer: 1, value: 'Silt', raw: 'Schluff', page: 7 }),
    makeValue({ key: K.spt(1), group: 'layer', layer: 1, raw: BAD_N.raw, value: 'N = 8', spt: BAD_N, lint: { severity: 'error', message: 'Increments 4 + 5 = 9 ≠ N 8' }, page: 7 }),
    makeValue({ key: K.lithology(2), group: 'layer', layer: 2, value: 'Gravel, sandy', raw: 'Kies, sandig', page: 8 }),
    makeValue({ key: K.spt(2), group: 'layer', layer: 2, raw: '50/30', value: 'refusal · 50 blows / 30 cm', spt: REFUSAL, refusal: true, page: 8 }),
    makeValue({ key: K.tcr(2), group: 'layer', layer: 2, value: '74', unit: '%', page: 8 }),
  ];
  return b;
}

describe('shown', () => {
  it('joins value and unit, and shows states in grey italics', () => {
    expect(shown(makeValue({ key: 'k', value: '18.00', unit: 'm' }))).toEqual({ text: '18.00 m', missing: false });
    expect(shown(makeValue({ key: 'k', value: '', state: 'not in source' }))).toEqual({ text: 'not in source', missing: true });
    expect(shown(makeValue({ key: 'k', value: '7', state: 'illegible' }))).toEqual({ text: 'illegible', missing: true });
    expect(shown(undefined)).toEqual({ text: 'not in source', missing: true });
  });
});

describe('metadataRows', () => {
  it('lists the eight rows in prototype order', () => {
    expect(metadataRows(shortLog()).map((r) => r.label)).toEqual([
      'Final depth', 'Rock head', 'Surface elevation', 'X / Y', 'CRS', 'Start date', 'Drilling method', 'Remarks',
    ]);
  });

  it('shows Lint on an unapproved lint, and drops it once approved', () => {
    const b = shortLog();
    expect(metadataRows(b)[0].chips.map((c) => c.label)).toEqual(['Lint']);
    b.values = b.values.map((v) => (v.key === K.finalDepth ? { ...v, status: 'approved' } : v));
    expect(metadataRows(b)[0].chips).toEqual([]);
  });

  it('marks the elevation datum as unconfirmed and the CRS by its status', () => {
    const rows = metadataRows(shortLog());
    expect(rows[2].chips.map((c) => c.label)).toEqual(['Datum unconfirmed']);
    expect(rows[4].chips.map((c) => c.label)).toEqual(['Stated']);
  });

  it('says "not reached" for a missing rock head, with nothing to point at', () => {
    const b = makeBorehole();
    const rock = metadataRows(b)[1];
    expect(rock.shown).toEqual({ text: 'not reached', missing: true });
    expect(rock.key).toBeNull();
    expect(rock.method).toBe('Derived');
  });

  it('fades the source icon for values that are not in the source', () => {
    const remarks = metadataRows(shortLog())[7];
    expect(remarks.shown).toEqual({ text: 'not in source', missing: true });
    expect(remarks.source).toEqual({ clickable: true, title: 'Show source', dim: true });
  });

  it('shows a flag as a chip', () => {
    const b = shortLog();
    b.values = b.values.map((v) => (v.key === K.crs ? { ...v, status: 'flagged', flag: 'check zone' } : v));
    expect(metadataRows(b)[4].chips.map((c) => c.label)).toEqual(['Stated', 'Flagged']);
  });
});

describe('crsChip', () => {
  const chip = (status: Borehole['crs']['status']) => crsChip(makeBorehole({ crs: { name: 'x', code: null, status } }));

  it('maps every CRS status to a sentence-case chip', () => {
    expect([chip('inferred'), chip('confirmed'), chip('stated'), chip('unknown')].map((c) => c.label)).toEqual([
      'Inferred', 'Confirmed', 'Stated', 'Unknown',
    ]);
  });

  // Green means reviewed, never "correct": a CRS printed in the report is not checked yet.
  it('is green only once a reviewer confirmed the CRS', () => {
    expect([chip('inferred'), chip('confirmed'), chip('stated'), chip('unknown')].map((c) => c.tone)).toEqual(['amber', 'green', 'grey', 'red']);
  });
});

// X05: numbers in the mono face, words in the sans.
describe('metadata row faces', () => {
  it('marks depths, elevation, X / Y and the start date as numeric', () => {
    const numeric = metadataRows(shortLog()).filter((r) => r.numeric).map((r) => r.label);
    expect(numeric).toEqual(['Final depth', 'Rock head', 'Surface elevation', 'X / Y', 'Start date']);
  });
});

// int-10: a borehole without a source document had icons that only answered with a toast.
describe('sourceLink', () => {
  it('opens the source of a value, faded when nothing is printed', () => {
    const b = shortLog();
    expect(sourceLink(b, K.finalDepth)).toEqual({ clickable: true, title: 'Show source', dim: false });
    expect(sourceLink(b, K.notes)).toEqual({ clickable: true, title: 'Show source', dim: true });
  });

  it('still opens the first page for a value without a page of its own', () => {
    const b = shortLog();
    b.values = b.values.map((v) => (v.key === K.finalDepth ? { ...v, page: null } : v));
    expect(sourceLink(b, K.finalDepth)).toEqual({ clickable: true, title: 'Show source', dim: true });
  });

  it('is inert without a key', () => {
    expect(sourceLink(shortLog(), null)).toEqual({ clickable: false, title: 'Nothing printed to show', dim: true });
    expect(metadataRows(makeBorehole())[1].source).toEqual({ clickable: false, title: 'Nothing printed to show', dim: true });
  });

  it('is inert for a borehole without a source document, in every table', () => {
    const b = { ...shortLog(), documentId: null };
    const none = { clickable: false, title: 'No source page from the backend yet', dim: true };
    expect(sourceLink(b, K.finalDepth)).toEqual(none);
    expect(metadataRows(b).every((r) => !r.source.clickable)).toBe(true);
    expect(layerRows(b).map((r) => r.source)).toEqual([none, none]);
    expect(layerRows(b)[1].spt).toMatchObject({ source: none });
    expect(layerRows(b)[1].spt?.title).toMatch(/No source page from the backend yet\.$/);
    expect(groundwaterRows(b)[0].source).toEqual(none);
  });
});

describe('reviewedText', () => {
  it('counts approved values, or says all are reviewed', () => {
    const b = makeBorehole();
    expect(reviewedText(b)).toBe(`0 of ${b.values.length} values reviewed`);
    b.values = b.values.map((v) => ({ ...v, status: 'approved' }));
    expect(reviewedText(b)).toBe('all values reviewed');
  });

  it('explains "needs attention" when every value is approved but the CRS is still inferred', () => {
    const b = makeBorehole({ crs: { name: 'DHDN / GK zone 3', code: 'EPSG:31467', status: 'inferred' } });
    b.values = b.values.map((v) => ({ ...v, status: 'approved' }));
    expect(reviewedText(b)).toBe('all values reviewed · CRS inferred, not stated');
  });
});

describe('shortCrsName', () => {
  it('shortens the long CRS names for the map caption', () => {
    expect(shortCrsName('ETRS89 / UTM zone 32N')).toBe('ETRS89 / UTM 32N');
    expect(shortCrsName('DHDN / 3-degree Gauss-Krüger zone 3')).toBe('DHDN / GK zone 3');
    expect(shortCrsName('local site grid')).toBe('local site grid');
  });
});

describe('locationInfo', () => {
  it('names the CRS the position comes from', () => {
    expect(locationInfo(makeBorehole({ lat: 48.7905, lng: 9.1835 }))).toEqual({
      text: '48.7905, 9.1835 · from ETRS89 / UTM 32N (stated)',
      tone: 'muted',
    });
    const inferred = makeBorehole({ crs: { name: 'DHDN / GK zone 3', code: 'EPSG:31467', status: 'inferred' } });
    expect(locationInfo(inferred).tone).toBe('amber');
    expect(locationInfo(inferred).text).toContain('from inferred CRS, confirm in review');
  });

  it('explains a borehole that is not on the map', () => {
    const b = makeBorehole({ lat: null, lng: null, onMap: false, unplottedReason: 'No coordinates in source' });
    expect(locationInfo(b)).toEqual({ text: 'No coordinates in source: not on the map', tone: 'red' });
  });
});

describe('layerRows', () => {
  it('shows a refusal as printed with an R, never as N = 50', () => {
    const rows = layerRows(shortLog());
    expect(rows[1].spt).toMatchObject({ text: '50/30', refusal: true, key: K.spt(2), lint: false });
    expect(rows[1].spt?.title).toContain('Not N = 50');
    expect(rows.map((r) => r.spt?.text)).not.toContain('N = 50');
  });

  it('marks an SPT whose increments do not add up', () => {
    expect(layerRows(shortLog())[0].spt).toMatchObject({ text: 'N = 8', refusal: false, lint: true });
  });

  it('fills range, printed text, TCR / RQD and the source key', () => {
    const r = layerRows(shortLog())[1];
    expect(r.range).toBe('8.20–14.50');
    expect(r.printed).toBe('As printed: Kies, sandig');
    expect(r.tcr).toBe('74');
    expect(r.rqd).toBe('–');
    expect(r.sourceKey).toBe(K.lithology(2));
  });

  it('has no SPT cell for a layer without a test', () => {
    expect(layerRows(makeBorehole())[0].spt).toBeNull();
  });
});

describe('layerLint', () => {
  it('suggests the next sheet when the log ends above the final depth', () => {
    expect(layerLint(shortLog())).toEqual({
      text: 'Log bottom 14.50 m ≠ final depth 18.00 m. Possibly a missing sheet 3.',
      severity: 'error',
    });
  });

  it('is null without an open lint on the final depth', () => {
    expect(layerLint(makeBorehole())).toBeNull();
  });
});

describe('groundwaterRows', () => {
  it('shows type, depth and the raw text', () => {
    expect(groundwaterRows(shortLog())).toEqual([
      {
        key: K.gwStrike, type: 'Strike', depth: { text: '3.10 m bgl', missing: false }, raw: '“GW 3,10”', method: 'Read', confidence: 0.9,
        source: { clickable: true, title: 'Show source', dim: false },
      },
    ]);
  });
});

describe('export menu counts', () => {
  it('counts the unapproved values of every borehole in the same document', () => {
    const a = makeBorehole();
    const b = makeBorehole({ uid: 'doc:TB-02', id: 'TB-02', values: a.values.map((v) => ({ ...v, status: 'approved' })) });
    const other = makeBorehole({ uid: 'x:TB-03', id: 'TB-03', documentId: 'x' });
    const scope = exportScope([a, b, other], a);
    expect(scope.map((x) => x.id)).toEqual(['TB-01', 'TB-02']);
    expect(unreviewedCount(scope)).toBe(a.values.length);
  });

  it('words the include switch', () => {
    expect(excludedText(30, false)).toBe('30 unreviewed values excluded');
    expect(excludedText(30, true)).toBe('30 unreviewed values included · file stamped DRAFT');
    expect(excludedText(0, false)).toBe('All values reviewed: nothing left out');
    expect(excludedText(272, false, 13)).toBe('272 unreviewed values in 13 boreholes excluded');
    expect(excludedText(1, true, 2)).toBe('1 unreviewed value in 2 boreholes included · file stamped DRAFT');
  });
});
