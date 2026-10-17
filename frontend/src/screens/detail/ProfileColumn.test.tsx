/** The DIN 4023 profile and its legend. Every borehole here is fictional (src/test/fixtures). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import { applyValuePatch } from '../../domain/review';
import type { Borehole, Layer, Spt } from '../../domain/types';
import { makeBorehole, makeLayer, makeValue } from '../../test/fixtures';
import { ProfileColumn, ProfileLegend } from './ProfileColumn';
import { isStated } from './profileGeometry';

const refusal: Spt = { raw: '50/30', depth: 4, refusal: true, blows: 50, penetrationCm: 30 };

function borehole(): Borehole {
  const b = makeBorehole({
    rockHead: 2.5,
    layers: [makeLayer({ n: 1, from: 0, to: 2.5 }), makeLayer({ n: 2, from: 2.5, to: 6, din: 'T', dinNotation: 'T', spt: refusal })],
  });
  return {
    ...b,
    values: [
      ...b.values,
      makeValue({ key: K.rockHead, field: 'RockHead', value: '2.50', unit: 'm' }),
      makeValue({ key: K.spt(2), field: 'SPT', group: 'layer', layer: 2, raw: '50/30', value: 'refusal · 50 blows / 30 cm', spt: refusal, refusal: true }),
    ],
  };
}

/** A borehole with the given layers and nothing else drawn (no groundwater, no rock head). */
const withLayers = (layers: Layer[]): Borehole =>
  makeBorehole({ layers, groundwater: [], logBottom: layers.at(-1)?.to ?? 0, finalDepth: layers.at(-1)?.to ?? null });

const render = (b: Borehole) =>
  renderToStaticMarkup(<ProfileColumn borehole={b} selectedLayer={1} onSelectLayer={() => undefined} onOpenSource={() => undefined} />);

const legend = (b: Borehole) => renderToStaticMarkup(<ProfileLegend borehole={b} />);

/** The markup of one layer button, up to the next button. */
function layerGroup(html: string, n: number): string {
  const start = html.indexOf(`aria-label="Layer ${n}:`);
  expect(start, `layer ${n}`).toBeGreaterThan(-1);
  const end = html.indexOf('role="button"', start);
  return html.slice(start, end < 0 ? undefined : end);
}

describe('ProfileColumn', () => {
  it('draws groundwater, rock head and the SPT refusal marker the source states', () => {
    const html = render(borehole());
    expect(html).toContain('GW strike 1.80 m: show source');
    expect(html).toContain('rock head 2.50');
    expect(html).toContain('SPT refusal 50/30 at 4.00 m: show source');
  });

  // Regression (c22): a reading marked "not in source" was hidden in the table but still drawn.
  it('leaves out measurements the reviewer marked "not in source" or "illegible"', () => {
    let b = borehole();
    b = applyValuePatch(b, K.gw(0), { state: 'not in source', status: 'approved' });
    b = applyValuePatch(b, K.rockHead, { state: 'illegible', status: 'approved' });
    b = applyValuePatch(b, K.spt(2), { state: 'not in source', status: 'approved' });
    const html = render(b);
    expect(html).not.toContain('GW strike');
    expect(html).not.toContain('rock head 2.50');
    expect(html).not.toContain('SPT refusal');
  });

  it('skips groundwater readings without a depth (an elevation or a remark only)', () => {
    const b = { ...borehole(), groundwater: [{ type: 'rest' as const, depth: null, elevation: 212.4, date: null, raw: 'dry', key: K.gw(0) }] };
    expect(render(b)).not.toContain('GW rest');
  });

  it('says "ET not stated" when the final depth is unknown', () => {
    expect(render({ ...borehole(), finalDepth: null })).toContain('ET not stated');
  });

  it('fills a known code with its DIN 4023 pattern', () => {
    const html = render(borehole());
    expect(layerGroup(html, 1)).toContain('fill="url(#din-soil_S)"');
    expect(layerGroup(html, 2)).toContain('fill="url(#din-soil_T)"');
  });

  it('keeps codes case-sensitive: mG and Mg are different patterns', () => {
    const html = render(withLayers([makeLayer({ n: 1, from: 0, to: 3, din: 'mG', dinNotation: 'mG' }), makeLayer({ n: 2, from: 3, to: 6, din: 'Mg', dinNotation: 'Mg' })]));
    expect(layerGroup(html, 1)).toContain('fill="url(#din-soil_mG)"');
    expect(layerGroup(html, 2)).toContain('fill="url(#din-geological_Mg)"');
  });

  it('fills an unknown code solid red, labelled "no pattern assigned", and writes the code', () => {
    const g = layerGroup(render(withLayers([makeLayer({ n: 1, from: 0, to: 6, din: 'Qz', dinNotation: null })])), 1);
    expect(g).toContain('fill="#C8102E"');
    expect(g).not.toContain('url(#din-');
    expect(g).toContain('>no pattern assigned</text>');
    expect(g).toMatch(/>Qz<\/text>/);
    expect(g).toContain('Qz is not a DIN 4023 code');
  });

  it('draws the first secondary component over the right half and two equal parts side by side', () => {
    const html = render(
      withLayers([
        makeLayer({ n: 1, from: 0, to: 3, din: 'U', dinNotation: "U, s'" }),
        makeLayer({ n: 2, from: 3, to: 6, din: 'S', dinNotation: 'S/G' }),
      ]),
    );
    expect(layerGroup(html, 1)).toMatch(/x="170"[^>]*fill="url\(#din-sym-soil_S\)"/);
    expect(layerGroup(html, 2)).toContain('fill="url(#din-sym-soil_S)"');
    expect(layerGroup(html, 2)).toContain('fill="url(#din-sym-soil_G)"');
  });

  it('draws the Table 6 properties the record states and nothing for words no DIN term matches', () => {
    const html = render(
      withLayers([
        makeLayer({ n: 1, from: 0, to: 3, din: 'T', consistency: 'stiff', moisture: 'wet' }),
        makeLayer({ n: 2, from: 3, to: 6, din: 'Sst', weathering: 'W2', consistency: 'crumbly-ish', moisture: 'damp' }),
      ]),
    );
    expect(layerGroup(html, 1)).toContain('data-prop="consistency_stiff"');
    expect(layerGroup(html, 1)).toContain('data-prop="moisture_wet"');
    expect(layerGroup(html, 2)).toContain('data-prop="weathering_w2_3"');
    expect(layerGroup(html, 2)).not.toContain('data-prop="consistency');
    expect(layerGroup(html, 2)).not.toContain('data-prop="moisture');
  });

  it('draws the cored line only for a layer the record says is cored', () => {
    const html = render(withLayers([makeLayer({ n: 1, from: 0, to: 3, isCore: true }), makeLayer({ n: 2, from: 3, to: 6, isCore: null })]));
    expect(layerGroup(html, 1)).toContain('data-cored');
    expect(layerGroup(html, 2)).not.toContain('data-cored');
  });

  it('draws sample markers at their depth, pickable, water samples as a triangle', () => {
    const b = {
      ...withLayers([makeLayer({ n: 1, from: 0, to: 6 })]),
      samples: [
        { name: 'P1', typeCode: 'GP', from: 1, to: 1.5, key: K.sampleName(0) },
        { name: 'W2', typeCode: 'W', from: 3, to: null, key: K.sampleName(1) },
        { name: 'P3', typeCode: null, from: null, to: null, key: K.sampleName(2) },
      ],
    };
    const html = renderToStaticMarkup(
      <ProfileColumn borehole={b} selectedLayer={1} onSelectLayer={() => undefined} onOpenSource={() => undefined} selectedSample={1} onSelectSample={() => undefined} />,
    );
    expect(html).toContain('aria-label="Sample P1 at 1.50 m" aria-pressed="false"');
    expect(html).toContain('aria-label="Water sample W2 at 3.00 m" aria-pressed="true"');
    expect(html).not.toContain('P3');
  });

  it('has no buttons when read-only (the printable sheet)', () => {
    const html = renderToStaticMarkup(
      <ProfileColumn borehole={borehole()} selectedLayer={1} onSelectLayer={() => undefined} onOpenSource={() => undefined} readOnly />,
    );
    expect(html).not.toContain('role="button"');
    expect(html).toContain('rock head 2.50');
  });

  it('fills a layer without a code plain #E0E0E0 and writes no code', () => {
    const g = layerGroup(render(withLayers([makeLayer({ n: 1, from: 0, to: 6, din: null, dinNotation: null })])), 1);
    expect(g).toContain('fill="#E0E0E0"');
    expect(g).not.toContain('url(#din-');
    expect(g).toContain('no DIN code');
    expect(g).not.toContain('font-weight="700"');
  });

  it('puts a white underlay under A (fill), whose pattern has no colour', () => {
    const g = layerGroup(render(withLayers([makeLayer({ n: 1, from: 0, to: 6, din: 'A', dinNotation: 'A' })])), 1);
    const underlay = g.indexOf('fill="#fff"');
    const pattern = g.indexOf('fill="url(#din-geological_A)"');
    expect(underlay).toBeGreaterThan(-1);
    expect(pattern).toBeGreaterThan(underlay);
    expect(layerGroup(render(borehole()), 1)).not.toContain('fill="#fff"');
  });

  it('labels a layer with its DIN notation when it fits, else with its code', () => {
    const html = render(
      withLayers([
        makeLayer({ n: 1, from: 0, to: 3, din: 'U', dinNotation: "U, t, s'" }),
        makeLayer({ n: 2, from: 3, to: 6, din: 'S', dinNotation: "S, u, g', t', x', h', organic, very long notation" }),
      ]),
    );
    expect(layerGroup(html, 1)).toContain('>U, t, s&#x27;</text>');
    expect(layerGroup(html, 2)).toMatch(/font-weight="700"[^>]*>S<\/text>/);
  });

  it('marks an SPT refusal without a stated depth inside its layer as "depth not stated"', () => {
    const spt: Spt = { raw: '50/8', depth: null, refusal: true, blows: 50, penetrationCm: 8 };
    const b = withLayers([makeLayer({ n: 1, from: 0, to: 3 }), makeLayer({ n: 2, from: 3, to: 7.5, din: 'T', spt })]);
    const html = render(b);
    expect(html).toContain('aria-label="SPT refusal 50/8 depth not stated: show source"');
    expect(html).toContain('SPT refusal “50/8” depth not stated (layer 2, 3.00–7.50 m)');
    // Never an invented depth: not the layer middle (5.25 m), in neither notation.
    expect(html).not.toMatch(/5[.,]25/);
    expect(html).not.toMatch(/SPT refusal 50\/8 at /);
  });

  it('uses no objectBoundingBox pattern', () => {
    expect(render(borehole())).not.toContain('objectBoundingBox');
    expect(legend(borehole())).not.toContain('objectBoundingBox');
  });

  it('shows the stratigraphic name as text on a neutral fill, merging consecutive equal names', () => {
    const html = render(
      withLayers([
        makeLayer({ n: 1, from: 0, to: 2, stratigraphicName: 'Holocene' }),
        makeLayer({ n: 2, from: 2, to: 4, stratigraphicName: 'Holocene' }),
        makeLayer({ n: 3, from: 4, to: 6, stratigraphicName: null }),
      ]),
    );
    expect(html).toContain('Stratigraphy: Holocene, 0.00–4.00 m');
    expect(html).toContain('Stratigraphy: not stated, 4.00–6.00 m');
    expect(html.match(/>Holocene<\/text>/g)).toHaveLength(1);
  });
});

describe('ProfileLegend', () => {
  /** Codes listed in the legend, in order. */
  const codes = (html: string) => [...html.matchAll(/data-din="([^"]*)"/g)].map((m) => m[1]);

  it('lists exactly the DIN codes the profile uses, with swatch and English name', () => {
    const html = legend(borehole());
    expect(codes(html)).toEqual(['S', 'T']);
    expect(html).toContain('fill="url(#din-soil_S)"');
    expect(html).toContain('Sand');
    expect(html).toContain('Clay');
    expect(html).toContain('title="T: Clay (Ton)"');
  });

  it('lists the groundwater symbols of the readings drawn, the refusal item and says "nach DIN 4023"', () => {
    const b = borehole();
    const html = legend({ ...b, groundwater: [...b.groundwater, { type: 'rest', depth: 2, elevation: null, date: null, raw: null, key: K.gw(1) }] });
    expect(html).toContain('GW strike');
    expect(html).toContain('GW rest level');
    expect(html).toContain('SPT refusal (click)');
    expect(html).toContain('nach DIN 4023');
  });

  it('lists unknown codes red ("no pattern assigned") and notes layers without a code', () => {
    const b = withLayers([
      makeLayer({ n: 1, from: 0, to: 1, din: 'A' }),
      makeLayer({ n: 2, from: 1, to: 2, din: 'Qz' }),
      makeLayer({ n: 3, from: 2, to: 3, din: null }),
      makeLayer({ n: 4, from: 3, to: 4, din: 'A' }),
    ]);
    const html = legend(b);
    expect(codes(html)).toEqual(['A', 'Qz']);
    expect(html).toContain('Qz is not a DIN 4023 code');
    expect(html).toContain('no pattern assigned');
    expect(html).toContain('fill="#C8102E"');
    expect(html).toContain('no DIN code in source');
    expect(html).toContain('fill="#E0E0E0"');
    expect(html).toContain('fill="#fff"');
  });
});

describe('isStated', () => {
  it('is true without a value, and for a value in state ok only', () => {
    const b = borehole();
    expect(isStated(b, 'no-such-key')).toBe(true);
    expect(isStated(b, K.gw(0))).toBe(true);
    expect(isStated(applyValuePatch(b, K.gw(0), { state: 'illegible' }), K.gw(0))).toBe(false);
  });
});
