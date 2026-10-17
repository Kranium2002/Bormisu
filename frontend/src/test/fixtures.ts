/** Tiny fictional fixtures for unit tests. Not used by the app. */
import { K } from '../domain/keys';
import type { Borehole, BoreholeMeta, DocumentPage, DocumentSummary, ExtractedValue, Layer } from '../domain/types';

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
    hasProvenance: true,
    method: 'Read',
    confidence: 0.9,
    status: 'unreviewed',
    state: 'ok',
    aiValue: o.value ?? '',
    ...o,
  };
}

/** Builds a layer with sensible defaults (a fictional sand layer, DIN code `S`). */
export function makeLayer(o: Partial<Layer> & Pick<Layer, 'n' | 'from' | 'to'>): Layer {
  return {
    lithology: 'Sand',
    lithologyAsPrinted: 'Sand',
    din: 'S',
    dinNotation: 'S',
    stratigraphicName: null,
    engineeringSoilUnit: null,
    geologicAge: null,
    colour: null,
    consistency: null,
    moisture: null,
    weathering: null,
    isCore: null,
    method: 'Read',
    confidence: 0.9,
    ...o,
  };
}

/** Metadata with every field unknown. */
export function makeMeta(o: Partial<BoreholeMeta> = {}): BoreholeMeta {
  return {
    aliases: [],
    elevationDatum: null,
    depthOrigin: null,
    depthSource: null,
    xRaw: null,
    yRaw: null,
    axisLabelsRaw: null,
    localX: null,
    localY: null,
    ...o,
  };
}

/** A fictional two-layer borehole "TB-01" with a stated CRS. Its BoreholeID value follows `o.id`. */
export function makeBorehole(o: Partial<Borehole> = {}): Borehole {
  const id = o.id ?? 'TB-01';
  return {
    uid: 'bh_TEST0000000000000000000001',
    id,
    documentId: 'doc_TEST0000000000000000000001',
    sourceFile: 'test_report.pdf',
    project: 'Test Project (fictional)',
    revision: 1,
    reviewStatus: 'unreviewed',
    openClarifications: 0,
    lat: 50,
    lng: 8,
    onMap: true,
    unplottedReason: null,
    finalDepth: 6,
    logBottom: 6,
    crs: { name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', status: 'stated' },
    meta: makeMeta(),
    layers: [makeLayer({ n: 1, from: 0, to: 2.5 }), makeLayer({ n: 2, from: 2.5, to: 6, din: 'T', dinNotation: 'T', lithology: 'Clay' })],
    groundwater: [{ type: 'strike', depth: 1.8, elevation: null, date: null, raw: '1,80 m', key: K.gw(0) }],
    samples: [],
    testResults: [],
    rockHead: null,
    values: [
      makeValue({ key: K.boreholeId, field: 'BoreholeID', value: id, raw: id.replace('-', ' ') }),
      makeValue({ key: K.finalDepth, field: 'BoreholeDepth', value: '6.00', unit: 'm', raw: '6,00 m' }),
      makeValue({ key: K.gw(0), field: 'Groundwaterlevel', group: 'groundwater', value: '1.80', unit: 'm', raw: '1,80 m' }),
      makeValue({ key: K.bottom(1), field: 'DepthTo', group: 'layer', layer: 1, value: '2.50', unit: 'm' }),
      makeValue({ key: K.lithology(1), field: 'Lithology/SoilName', group: 'layer', layer: 1, value: 'Sand' }),
      makeValue({ key: K.bottom(2), field: 'DepthTo', group: 'layer', layer: 2, value: '6.00', unit: 'm' }),
      makeValue({ key: K.lithology(2), field: 'Lithology/SoilName', group: 'layer', layer: 2, value: 'Clay' }),
    ],
    pages: [1],
    primaryPage: 1,
    ...o,
  };
}

/** A classified page with sensible defaults (a used log page). */
export function makePage(o: Partial<DocumentPage> & Pick<DocumentPage, 'n'>): DocumentPage {
  return {
    type: 'log',
    role: 'log_sheet',
    used: true,
    unusedReason: null,
    boreholeIds: [],
    sheetLabel: null,
    handwriting: 'none',
    language: null,
    ocr: 'done',
    duplicateOf: null,
    classified: true,
    ...o,
  };
}

/** A fictional document in review with one log page. */
export function makeDocument(o: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: 'doc_TEST0000000000000000000001',
    name: 'test_report.pdf',
    project: 'Test Project (fictional)',
    status: 'needs_review',
    pages: [makePage({ n: 1 })],
    step: 2,
    progress: null,
    counts: { boreholes: 1, layers: 2, spt: 0, groundwater: 1 },
    completeness: null,
    reviewBoreholeUid: null,
    openClarifications: 0,
    duplicateOf: null,
    ...o,
  };
}
