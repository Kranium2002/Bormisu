/**
 * The Detail view model on records shaped like the backend's (the frontend's fictional contract
 * fixture, changed the way the seeded backend and contracts/examples send them). Findings of the M0
 * UI verification (uiv-*): the UI must show what the server says, never an invented status or value.
 */
import { describe, expect, it, vi } from 'vitest';
import { adaptBorehole, type WireBorehole } from '../../data/adapters';
import { K } from '../../domain/keys';
import { makeBorehole, makeMeta } from '../../test/fixtures';
import { fixture } from '../../test/contract/wire';
import { depthOriginText, groundwaterRows, locationInfo, metadataRows } from './detailModel';

/** The fixture record, adapted (the adapter logs nothing; the spy guards against a stray warning). */
function adapt(change: (w: WireBorehole) => void) {
  const wire = fixture<WireBorehole>('borehole');
  change(wire);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    return adaptBorehole(wire).borehole;
  } finally {
    warn.mockRestore();
  }
}

/** A CRS confirmed by a reviewer: the server has the EPSG code, the source printed no system name. */
const confirmedWithoutPrintedName = (w: WireBorehole) => {
  w.crs_status = 'confirmed';
  w.metadata.coordinates = { ...w.metadata.coordinates, coordinate_system: null, crs_code: 'EPSG:2193' };
  delete w.provenance['metadata.coordinates.coordinate_system'];
};

const row = (b: ReturnType<typeof adapt>, label: string) => metadataRows(b).find((r) => r.label === label);

describe('uiv-1: a confirmed or stated CRS without a printed name', () => {
  it('is not called "CRS unknown" under the location map', () => {
    const b = adapt(confirmedWithoutPrintedName);
    expect(b.onMap).toBe(true);
    const info = locationInfo(b);
    expect(info.text).not.toContain('CRS unknown');
    expect(info).toEqual({ text: '-36.8441, 174.7682 · from EPSG:2193 (confirmed)', tone: 'muted' });
  });

  it('shows the server’s EPSG code in the CRS row instead of "not in source"', () => {
    const crs = row(adapt(confirmedWithoutPrintedName), 'CRS');
    expect(crs?.shown).toEqual({ text: 'EPSG:2193', missing: false });
    expect(crs?.chips.map((c) => c.label)).toEqual(['CONFIRMED']);
    // Nothing printed to point at: no source icon, no method.
    expect(crs).toMatchObject({ key: null, source: 'none', method: null });
  });

  it('still says "CRS unknown" when the server says so', () => {
    const b = { ...makeBorehole(), crs: { name: null, code: null, status: 'unknown' as const } };
    expect(locationInfo(b)).toEqual({ text: '50.0000, 8.0000 · CRS unknown', tone: 'red' });
  });
});

describe('uiv-2: a rock head the backend does not state', () => {
  it('reads "not in source", with no method and no source icon, never "not reached (Derived)"', () => {
    const b = adapt((w) => {
      w.rock_head_m = null;
      delete w.provenance.rock_head_m;
    });
    const rock = row(b, 'Rock head');
    expect(rock?.shown).toEqual({ text: 'not in source', missing: true });
    expect(rock).toMatchObject({ key: null, method: null, source: 'none' });
  });
});

describe('uiv-3: the elevation datum is shown once', () => {
  it('adds the datum to the adapted record, whose unit is m (uiv-B3)', () => {
    const b = adapt(() => undefined);
    expect(row(b, 'Surface elevation')?.shown.text).toBe('12.40 m · datum NZVD2016');
  });

  it('does not repeat a datum the value’s unit already names', () => {
    const b = adapt(() => undefined);
    b.values = b.values.map((v) => (v.key === K.elevation ? { ...v, unit: 'm NZVD2016' } : v));
    expect(row(b, 'Surface elevation')?.shown.text).toBe('12.40 m NZVD2016');
  });
});

describe('uiv-4: depths are labelled with the stated depth origin, never an assumed "bgl"', () => {
  it('names the origin the source states, and says when it states none', () => {
    expect(depthOriginText(makeMeta({ depthOrigin: 'ground' }))).toBe('depth in m bgl');
    expect(depthOriginText(makeMeta({ depthOrigin: 'seabed' }))).toBe('depth in m below seabed');
    expect(depthOriginText(makeMeta({ depthOrigin: 'mudline' }))).toBe('depth in m below mudline');
    expect(depthOriginText(makeMeta({ depthOrigin: 'relative' }))).toBe('depth in m, relative to a stated level');
    expect(depthOriginText(makeMeta({ depthOrigin: null }))).toBe('depth in m, origin not stated');
  });

  it('a groundwater reading without a value row uses the same origin', () => {
    const b = makeBorehole({ meta: makeMeta({ depthOrigin: 'relative' }) });
    b.values = b.values.filter((v) => v.key !== K.gw(0));
    expect(groundwaterRows(b)[0].depth).toEqual({ text: '1.80 m, relative to a stated level', missing: false });
    const ground = makeBorehole({ meta: makeMeta({ depthOrigin: 'ground' }) });
    ground.values = ground.values.filter((v) => v.key !== K.gw(0));
    expect(groundwaterRows(ground)[0].depth).toEqual({ text: '1.80 m bgl', missing: false });
  });
});
