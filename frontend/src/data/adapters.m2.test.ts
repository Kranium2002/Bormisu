/**
 * The M2 adapters on the fictional fixtures (src/test/contract): the light map layer, filters and
 * areas in both directions, result sets, place candidates and clarification questions with their
 * form fields and evidence. Unknown stays unknown; nothing is guessed, and a feature or question this
 * client can't represent is left out with one console.info per batch.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { BoreholeFilter } from '../domain/types';
import { contractErrors } from '../test/contract/schema';
import { fixture } from '../test/contract/wire';
import {
  adaptArea,
  adaptClarification,
  adaptClarifications,
  adaptFeatures,
  adaptFilter,
  adaptLiveEvent,
  adaptPlaces,
  adaptResultSet,
  toWireArea,
  toWireFilter,
  type WireClarification,
  type WireFeatureCollection,
  type WireFilter,
  type WirePlace,
  type WireResultSet,
} from './adapters';

const HL01 = 'bh_01JFICT00000000000000HL01';
const D1 = 'doc_01JFICT0000000000000000D1';

/** A filter with every field unset. */
const EMPTY: BoreholeFilter = {
  search: null, country: null, project: null, documentId: null, minDepth: null, maxDepth: null, dinCodes: [],
  lithologyMinDepth: null, hasSpt: null, hasGroundwater: null, reviewStatus: [], includeUnreviewed: false, area: null,
};

let info: MockInstance<typeof console.info>;
beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => info.mockRestore());

describe('map features (GET /map/boreholes.geojson)', () => {
  it('maps every feature: [lon, lat] to lat / lng, statuses to the domain, absent fields to null', () => {
    const features = adaptFeatures(fixture<WireFeatureCollection>('map-features'));
    expect(features).toHaveLength(5);
    expect(features[0]).toEqual({
      uid: HL01, id: 'HL-01', project: 'Harbourline Tunnel (fictional)', documentId: D1, lat: -36.8441, lng: 174.7682,
      depth: 15.5, reviewStatus: 'in_review', crsStatus: 'stated', revision: 4, attention: true, openClarifications: 0,
    });
    expect(features[3]).toMatchObject({ id: 'TQ-01', project: null, reviewStatus: 'approved', crsStatus: 'confirmed' });
    // MP-01 sends only the required properties: unknown stays null, never 0 or a guessed status.
    expect(features[4]).toEqual({
      uid: 'bh_01JFICT00000000000000MP01', id: 'MP-01', project: null, documentId: null, lat: 40.7003, lng: -74.0121,
      depth: null, reviewStatus: 'in_review', crsStatus: 'stated', revision: null, attention: false, openClarifications: 0,
    });
    expect(info).not.toHaveBeenCalled();
  });

  it('leaves a feature with an unknown status string out, with one console.info for the batch', () => {
    const fc = fixture<WireFeatureCollection>('map-features');
    fc.features[0].properties.review_status = 'reviewed';
    fc.features[1].properties.crs_status = 'guessed';
    const features = adaptFeatures(fc);
    expect(features.map((f) => f.id)).toEqual(['KR-01', 'TQ-01', 'MP-01']);
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toMatch(/^Left 2 map features out/);
    expect(line).toContain('review_status "reviewed"');
    expect(line).toContain('crs_status "guessed"');
  });

  it('never places a feature without usable coordinates (no 0, no (0, 0))', () => {
    const fc = fixture<WireFeatureCollection>('map-features');
    fc.features[0].geometry.coordinates = [];
    fc.features[1].geometry.coordinates = [Number.NaN, 12];
    fc.features[2].geometry.coordinates = [10, 95];
    const features = adaptFeatures(fc);
    expect(features.map((f) => f.id)).toEqual(['TQ-01', 'MP-01']);
    expect(features.some((f) => f.lat === 0 && f.lng === 0)).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('takes the uid from the properties, else the feature id; attention without the flag follows an open question', () => {
    const fc = fixture<WireFeatureCollection>('map-features');
    const p = fc.features[4].properties as Record<string, unknown>;
    p.uid = '';
    p.open_clarifications = 2;
    const mp = adaptFeatures(fc)[4];
    expect([mp.uid, mp.attention, mp.openClarifications]).toEqual(['bh_01JFICT00000000000000MP01', true, 2]);
  });

  it('an empty collection is an empty list', () => {
    expect(adaptFeatures({ type: 'FeatureCollection', features: [] })).toEqual([]);
  });
});

describe('filters and areas (BoreholeFilter, Area*)', () => {
  it('an unset filter sends only include_unreviewed', () => {
    const wire = toWireFilter(EMPTY);
    expect(wire).toEqual({ include_unreviewed: false });
    expect(contractErrors('BoreholeFilter', wire)).toEqual([]);
  });

  it('sends every set field in snake_case, the circle as {center, radius_m}; blank texts are unset', () => {
    const filter: BoreholeFilter = {
      search: '  HL-0 ', country: 'Example Country', project: '   ', documentId: D1, minDepth: 0, maxDepth: 20.5,
      dinCodes: ['T', 'mG'], lithologyMinDepth: 3, hasSpt: false, hasGroundwater: true, reviewStatus: ['approved'],
      includeUnreviewed: true, area: { type: 'circle', center: [174.75, -36.85], radiusM: 1500 },
    };
    const wire = toWireFilter(filter);
    expect(wire).toEqual({
      search: 'HL-0', country: 'Example Country', document_id: D1, min_depth_m: 0, max_depth_m: 20.5,
      din4023_codes: ['T', 'mG'], lithology_min_depth_m: 3, has_spt: false, has_groundwater: true,
      review_status: ['approved'], include_unreviewed: true, area: { type: 'circle', center: [174.75, -36.85], radius_m: 1500 },
    });
    expect(contractErrors('BoreholeFilter', wire)).toEqual([]);
    // The caller's filter is not changed.
    expect(filter.search).toBe('  HL-0 ');
  });

  it('sends a bbox and a GeoJSON polygon as they are', () => {
    const polygon = { type: 'Polygon' as const, coordinates: [[[1, 2], [3, 2], [3, 4], [1, 2]]] };
    expect(toWireArea({ type: 'bbox', bbox: [1, 2, 3, 4] })).toEqual({ type: 'bbox', bbox: [1, 2, 3, 4] });
    const wire = toWireArea({ type: 'polygon', polygon });
    expect(wire).toEqual({ type: 'polygon', polygon });
    expect(contractErrors('AreaPolygon', wire)).toEqual([]);
  });

  it('reads a full wire filter and writes it back unchanged', () => {
    const wire = fixture<WireFilter>('borehole-filter-full');
    const filter = adaptFilter(wire);
    expect(filter).toEqual({
      search: 'HL-0', country: 'Example Country', project: 'Harbourline Tunnel (fictional)', documentId: D1,
      minDepth: 5, maxDepth: 20.5, dinCodes: ['T', 'mG'], lithologyMinDepth: 3, hasSpt: true, hasGroundwater: false,
      reviewStatus: ['unreviewed', 'in_review'], includeUnreviewed: true,
      area: { type: 'polygon', polygon: wire.area && 'polygon' in wire.area ? wire.area.polygon : null },
    });
    expect(toWireFilter(filter)).toEqual(wire);
  });

  it('reads absent fields as unset and include_unreviewed as the contract default (false)', () => {
    expect(adaptFilter({} as WireFilter)).toEqual(EMPTY);
    expect(adaptFilter(null)).toEqual(EMPTY);
    expect(adaptFilter({ include_unreviewed: true, has_spt: null, area: null })).toEqual({ ...EMPTY, includeUnreviewed: true });
  });

  it('reads only well-formed areas', () => {
    expect(adaptArea({ type: 'bbox', bbox: [1, 2, 3, 4] })).toEqual({ type: 'bbox', bbox: [1, 2, 3, 4] });
    expect(adaptArea({ type: 'circle', center: [8, 50], radius_m: 250 })).toEqual({ type: 'circle', center: [8, 50], radiusM: 250 });
    expect(adaptArea({ type: 'bbox', bbox: [1, 2, 3] })).toBeNull();
    expect(adaptArea({ type: 'circle', center: [8, 50] })).toBeNull();
    expect(adaptArea({ type: 'circle', center: [8, 50], radius_m: 0 })).toBeNull();
    expect(adaptArea({ type: 'polygon', polygon: { type: 'Point', coordinates: [1, 2] } })).toBeNull();
    expect(adaptArea({ type: 'hexagon' })).toBeNull();
    expect(adaptArea(null)).toBeNull();
  });
});

describe('result sets', () => {
  it('maps a result set with located and unlocated members', () => {
    const rs = adaptResultSet(fixture<WireResultSet>('result-set'));
    expect(rs).toEqual({
      id: 'rs_01JFICT000000000000000RS01', count: 3, locatedCount: 2, unlocatedCount: 1, excludedUnreviewed: 0,
      uids: [HL01, 'bh_01JFICT00000000000000HL02', 'bh_01JFICT00000000000000TQ02'],
      bbox: [174.7682, -36.8452, 174.7701, -36.8441], area: null,
      definition: { ...EMPTY, minDepth: 5, includeUnreviewed: true }, createdAt: '2026-10-17T09:00:00Z',
    });
  });

  it('maps an empty area result: the bbox of the area, the echoed circle, the excluded count', () => {
    const rs = adaptResultSet(fixture<WireResultSet>('result-set-area'));
    const circle = { type: 'circle', center: [174.75, -36.85], radiusM: 1500 };
    expect(rs).toMatchObject({ count: 0, uids: [], excludedUnreviewed: 1, bbox: [174.7, -36.9, 174.8, -36.8], area: circle });
    expect(rs.definition).toEqual({ ...EMPTY, reviewStatus: ['approved'], area: circle });
  });

  it('keeps an absent excluded count and a null bbox unknown; an absent echo is the definition area', () => {
    const wire = fixture<WireResultSet>('result-set-area');
    delete wire.excluded_unreviewed;
    delete wire.area;
    wire.bbox = null;
    const rs = adaptResultSet(wire);
    expect([rs.excludedUnreviewed, rs.bbox]).toEqual([null, null]);
    expect(rs.area).toEqual({ type: 'circle', center: [174.75, -36.85], radiusM: 1500 });
  });
});

describe('place candidates (GET /geocode)', () => {
  it('maps lon to lng and keeps absent bbox, kind and count unknown; zero stays zero', () => {
    const places = adaptPlaces(fixture<WirePlace[]>('places'));
    expect(places.map((p) => [p.source, p.boreholeCount])).toEqual([['uploaded', 2], ['geocoder', 2], ['geocoder', 0], ['geocoder', null]]);
    expect(places[0]).toEqual({
      label: 'Harbourline Tunnel (fictional) project site (uploaded)', lat: -36.8446, lng: 174.7691,
      bbox: [174.7672, -36.8462, 174.7711, -36.8431], source: 'uploaded', kind: 'project_site', boreholeCount: 2,
    });
    expect(places[3]).toEqual({
      label: '12 Example Street, Quietmoor (fictional)', lat: -41.2901, lng: 174.7802, bbox: null, source: 'geocoder', kind: null, boreholeCount: null,
    });
    expect(info).not.toHaveBeenCalled();
  });

  it('leaves out a candidate with an unknown source or no position, with one console.info', () => {
    const list = fixture<WirePlace[]>('places');
    (list[1] as { source: string }).source = 'guess';
    (list[2] as { lat: unknown }).lat = null;
    expect(adaptPlaces(list).map((p) => p.label)).toEqual([list[0].label, list[3].label]);
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe('clarifications', () => {
  const all = () => fixture<WireClarification[]>('clarifications');

  it('adapts every question of the fixture, covering every widget', () => {
    const list = adaptClarifications(all());
    expect(list).toHaveLength(7);
    expect(new Set(list.flatMap((c) => c.fields.map((f) => f.widget)))).toEqual(
      new Set(['text', 'number_unit', 'select', 'boolean', 'map_point', 'choose_reading', 'page_range', 'crs_picker']),
    );
    expect(info).not.toHaveBeenCalled();
  });

  it('maps the CRS question: options with evidence boxes, the default as sent (null stays null, false stays false)', () => {
    const c = adaptClarification(all()[0]);
    expect(c).toEqual({
      id: 'cl_01JFICT00000000000000CRS1', kind: 'crs_confirm', status: 'open', documentId: 'doc_01JFICT0000000000000000D7',
      boreholeUids: ['bh_01JFICT00000000000000LA01', 'bh_01JFICT00000000000000LA02'], path: null,
      question: 'Which coordinate system do the coordinates of the Lagoa Azul Metro boreholes use (fictional)?',
      fields: [
        {
          name: 'crs', widget: 'crs_picker', label: 'Coordinate system', help: 'Ranked by how compactly the points fall (fictional).',
          required: true, unitOptions: [], default: null,
          options: [
            {
              value: 'EPSG:31983', label: 'SIRGAS 2000 / UTM zone 23S',
              evidence: { documentId: 'doc_01JFICT0000000000000000D7', page: 2, box: { x: 0.1, y: 0.2, w: 0.4, h: 0.02 }, snippet: 'E 333 120  N 7 394 880' },
            },
            {
              value: 'EPSG:29193', label: 'SAD69 / UTM zone 23S',
              evidence: { documentId: 'doc_01JFICT0000000000000000D7', page: 2, box: { x: 0.1, y: 0.2, w: 0.4, h: 0.02 }, snippet: 'E 333 120  N 7 394 880' },
            },
          ],
        },
        { name: 'swap_axes', widget: 'boolean', label: 'The first printed value is the northing', help: null, required: false, unitOptions: [], options: [], default: false },
      ],
      evidence: [{ documentId: 'doc_01JFICT0000000000000000D7', page: 2, box: { x: 0.1, y: 0.2, w: 0.4, h: 0.02 }, snippet: 'E 333 120  N 7 394 880' }],
      answer: null, answeredBy: null, createdAt: '2026-10-17T08:00:00Z', resolvedAt: null,
    });
  });

  it('keeps absent parts absent: no default is undefined, no evidence on an option is null, required defaults to false', () => {
    const [, reading, unit, locate, boundary] = adaptClarifications(all());
    expect(reading.fields[0].default).toBeUndefined();
    expect('default' in reading.fields[0] ? reading.fields[0].default : undefined).toBeUndefined();
    expect(reading.fields[0].unitOptions).toEqual([]);
    expect(reading.fields[0].options[1]).toEqual({ value: 4.7, label: '4.70 (second read)', evidence: null });
    expect([reading.answer, reading.answeredBy, reading.resolvedAt]).toEqual([null, null, null]);
    expect(reading.path).toBe('stratigraphy[1].depth_to_m');
    expect(unit).toMatchObject({ status: 'skipped', fields: [{ widget: 'number_unit', unitOptions: ['kN/m³', 't/m³', 'g/cm³'], default: 1.95 }] });
    expect(unit.evidence).toEqual([{ documentId: D1, page: 9, box: null, snippet: 'γ = 1,95' }]);
    expect(locate.fields.map((f) => [f.widget, f.required, f.help, f.options, f.default])).toEqual([
      ['map_point', true, 'The site plan on page 3 shows TQ-02.', [], undefined],
      ['text', false, null, [], undefined],
    ]);
    expect(boundary.fields[0].default).toEqual([7, 7]);
  });

  it('maps an answered question with its answer, its author and when it was resolved', () => {
    const answered = adaptClarifications(all())[6];
    expect(answered).toMatchObject({
      kind: 'duplicate', status: 'answered', answer: { same_log: true }, answeredBy: 'A. Reviewer (fictional)', resolvedAt: '2026-10-17T08:30:00Z',
    });
    expect(answered.evidence[1]).toEqual({ documentId: D1, page: 8, box: null, snippet: null });
  });

  it('leaves out a question of an unknown kind or with an unknown widget, with one console.info for the list', () => {
    const list = all();
    (list[0] as { kind: string }).kind = 'mystery';
    (list[1].fields[0] as { widget: string }).widget = 'slider';
    expect(adaptClarification(list[0])).toBeNull();
    expect(adaptClarification(list[1])).toBeNull();
    expect(info).not.toHaveBeenCalled();
    expect(adaptClarifications(list).map((c) => c.id)).toHaveLength(5);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/^Left 2 questions out.*kind "mystery".*widget "slider"/);
  });

  it('rejects data without what the contract requires', () => {
    const c = all()[0] as unknown as Record<string, unknown>;
    for (const key of ['clarification_id', 'document_id', 'question', 'fields', 'created_at']) {
      const broken = { ...c };
      delete broken[key];
      expect(adaptClarification(broken), key).toBeNull();
    }
    expect(adaptClarification({ ...c, status: 'closed' })).toBeNull();
    expect(adaptClarification('not an object')).toBeNull();
  });

  it('a clarification.created event carries the whole adapted question; an unusable one is no event', () => {
    const data = fixture<WireClarification>('event-clarification-created');
    const event = adaptLiveEvent('clarification.created', data);
    expect(event).toEqual({ type: 'clarification.created', clarification: adaptClarification(data) });
    expect(event?.type === 'clarification.created' && event.clarification.fields[0].options).toHaveLength(2);
    expect(adaptLiveEvent('clarification.created', { ...data, kind: 'mystery' })).toBeNull();
  });
});
