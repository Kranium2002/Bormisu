/** Server-rendered detail tables (fictional borehole): layer columns, SPT depth, groundwater sources. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import { makeBorehole, makeLayer, makeValue } from '../../test/fixtures';
import { GroundwaterTable } from './GroundwaterTable';
import { LayersTable } from './LayersTable';

const noop = () => undefined;

describe('LayersTable', () => {
  it('shows the DIN notation, the English lithology with the original on hover, and the stratigraphic name', () => {
    const b = makeBorehole({
      layers: [
        makeLayer({
          n: 1, from: 0, to: 2.5, dinNotation: "U, t, s'", stratigraphicName: 'Fictional Formation',
          spt: { raw: '50/7', depth: null, refusal: true, blows: 50, penetrationCm: 7 },
        }),
      ],
    });
    b.values = [makeValue({ key: K.lithology(1), group: 'layer', layer: 1, value: 'Silt, clayey', raw: 'Silt, clayey (original)' })];
    const html = renderToStaticMarkup(<LayersTable borehole={b} selectedLayer={1} onSelectLayer={noop} onOpenSource={noop} />);
    expect(html).toContain('U, t, s&#x27;');
    expect(html).toContain('Fictional Formation');
    expect(html).toContain('title="As printed: Silt, clayey (original)"');
    expect(html).toContain('SPT depth not stated.');
    expect(html).not.toMatch(/SPT at/);
  });
});

describe('GroundwaterTable', () => {
  it('shows a source icon only for readings with a provenance entry', () => {
    const b = makeBorehole({
      groundwater: [
        { type: 'strike', depth: 1.8, elevation: null, date: null, raw: '1,80 m', key: K.gw(0) },
        { type: 'other', depth: null, elevation: null, date: null, raw: 'dry', key: K.gw(1) },
      ],
    });
    b.values = [makeValue({ key: K.gw(0), group: 'groundwater', value: '1.80', unit: 'm' })];
    const html = renderToStaticMarkup(<GroundwaterTable borehole={b} onOpenSource={noop} />);
    expect(html.match(/aria-label="Show source"/g)).toHaveLength(1);
    expect(html).toContain('depth not stated');
    expect(html).toContain('“dry”');
  });
});
