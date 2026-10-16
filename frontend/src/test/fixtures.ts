/** Tiny fictional fixtures for unit tests. Not used by the app. */
import { K } from '../domain/keys';
import type { Borehole, ExtractedValue, Layer } from '../domain/types';

/** Builds an extracted value with sensible defaults. */
export function makeValue(o: Partial<ExtractedValue> & Pick<ExtractedValue, 'key'>): ExtractedValue {
  return {
    field: o.key,
    label: o.key,
    group: 'borehole',
    raw: '',
    value: '',
    unit: '',
    page: 1,
    box: null,
    method: 'Read',
    confidence: 0.9,
    status: 'unreviewed',
    state: 'ok',
    aiValue: o.value ?? '',
    ...o,
  };
}

/** Builds a layer with sensible defaults. */
export function makeLayer(o: Partial<Layer> & Pick<Layer, 'n' | 'from' | 'to'>): Layer {
  return {
    lithology: 'Sand',
    lithologyAsPrinted: 'Sand',
    din: 'S',
    pattern: 'sand',
    fill: '#FFF5B0',
    strat: 'qh',
    method: 'Read',
    confidence: 0.9,
    ...o,
  };
}

/** A fictional two-layer borehole "TB-01" with a stated CRS. Its BoreholeID value follows `o.id`. */
export function makeBorehole(o: Partial<Borehole> = {}): Borehole {
  const id = o.id ?? 'TB-01';
  return {
    uid: 'doc:TB-01',
    id,
    documentId: 'doc',
    sourceFile: 'test_report.pdf',
    project: 'Test Project (fictional)',
    lat: 50,
    lng: 8,
    onMap: true,
    unplottedReason: null,
    finalDepth: 6,
    logBottom: 6,
    crs: { name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', status: 'stated' },
    layers: [makeLayer({ n: 1, from: 0, to: 2.5 }), makeLayer({ n: 2, from: 2.5, to: 6, pattern: 'clay' })],
    groundwater: [{ type: 'strike', depth: 1.8, key: K.gwStrike }],
    rockHead: null,
    values: [
      makeValue({ key: K.boreholeId, field: 'BoreholeID', value: id, raw: id.replace('-', ' ') }),
      makeValue({ key: K.finalDepth, field: 'BoreholeDepth', value: '6.00', unit: 'm', raw: '6,00 m' }),
      makeValue({ key: K.gwStrike, field: 'Groundwaterlevel', group: 'groundwater', value: '1.80', unit: 'm bgl' }),
      makeValue({ key: K.bottom(1), field: 'DepthTo', group: 'layer', layer: 1, value: '2.50', unit: 'm' }),
      makeValue({ key: K.lithology(1), field: 'Lithology/SoilName', group: 'layer', layer: 1, value: 'Sand' }),
      makeValue({ key: K.bottom(2), field: 'DepthTo', group: 'layer', layer: 2, value: '6.00', unit: 'm' }),
      makeValue({ key: K.lithology(2), field: 'Lithology/SoilName', group: 'layer', layer: 2, value: 'Clay' }),
    ],
    primaryPage: 1,
    ...o,
  };
}
