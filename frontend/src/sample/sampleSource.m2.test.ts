// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/**
 * The sample source's M2 calls: map features and the "Not on map" list, result sets with the
 * backend's semantics on the sample archive, place search over the fictional gazetteer, and the
 * clarification questions (the open-question counts they make, answer checks, answer and skip effects,
 * live events).
 */
import { describe, expect, it } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { ApiError } from '../data/errors';
import { K } from '../domain/keys';
import { displayStatus } from '../domain/status';
import type { Borehole, BoreholeFilter, BoreholeStatus, Clarification, LiveEvent, MapFeature } from '../domain/types';
import { areaBbox, boundsOf, haversineM } from './query';
import { createSampleSource } from './sampleSource';

const EMPTY: BoreholeFilter = {
  search: null, country: null, project: null, documentId: null, minDepth: null, maxDepth: null, dinCodes: [],
  lithologyMinDepth: null, hasSpt: null, hasGroundwater: null, reviewStatus: [], includeUnreviewed: false, area: null,
};
const f = (o: Partial<BoreholeFilter>): BoreholeFilter => ({ ...EMPTY, ...o });
const NB = 'Stadtbahn Neckarbogen';

/** Every full record of a source (the placed ones fetched by uid) and its features. */
async function everything(src: DataSource): Promise<{ boreholes: Borehole[]; features: MapFeature[] }> {
  const { features, unplotted } = await src.load();
  const placed = await Promise.all(features.map((x) => src.getBorehole(x.uid)));
  return { boreholes: [...placed, ...unplotted], features };
}
const byId = (bs: Borehole[], id: string) => bs.find((b) => b.id === id) as Borehole;
const uidsOf = (bs: Borehole[]) => bs.map((b) => b.uid).sort();
const legend = (features: MapFeature[]) => {
  const out: Record<BoreholeStatus, number> = { approved: 0, in_review: 0, unreviewed: 0, attention: 0 };
  for (const x of features) out[x.attention ? 'attention' : x.reviewStatus] += 1;
  return out;
};
/** A source with a recorder of its live events. */
function recorded(): { src: DataSource; events: LiveEvent[] } {
  const src = createSampleSource();
  const events: LiveEvent[] = [];
  src.subscribe((e) => events.push(e), () => undefined);
  return { src, events };
}
const question = async (src: DataSource, kind: Clarification['kind']) => (await src.clarifications()).find((q) => q.kind === kind) as Clarification;
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('map features and the "Not on map" list', () => {
  it('mapFeatures() is the whole layer, mapFeatures(document) only its placed boreholes; unplotted() the three records', async () => {
    const src = createSampleSource();
    expect(await src.mapFeatures()).toHaveLength(45);
    const nb = await src.mapFeatures('nb');
    expect(nb).toHaveLength(11);
    expect(nb.every((x) => x.documentId === 'nb' && x.project === NB && x.crsStatus === 'inferred')).toBe(true);
    expect((await src.unplotted()).map((b) => b.id)).toEqual(['BK-13', 'BK-14', 'SK-05']);
  });

  it('a borehole placed later joins the layer (CL-04 answered to a new position moves its pin)', async () => {
    const src = createSampleSource();
    const q = await question(src, 'locate_borehole');
    await src.answerClarification(q.id, { location: { lat: 51.3333, lon: 12.3888 } }, null);
    const pin = (await src.mapFeatures()).find((x) => x.id === 'CL-04');
    expect([pin?.lat, pin?.lng]).toEqual([51.3333, 12.3888]);
  });
});

describe('result sets (the backend semantics on the sample archive)', () => {
  it('include_unreviewed false (the default) keeps approved boreholes and counts the others; ids are rs_ and a counter', async () => {
    const src = createSampleSource();
    const { boreholes } = await everything(src);
    const nb = boreholes.filter((b) => b.project === NB);
    const approved = nb.filter((b) => b.reviewStatus === 'approved');
    const rs = await src.createResultSet(f({ project: NB }));
    expect(rs).toMatchObject({
      id: 'rs_1', count: approved.length, excludedUnreviewed: nb.length - approved.length, uids: uidsOf(approved),
      locatedCount: approved.length, unlocatedCount: 0, area: null, definition: f({ project: NB }),
    });
    expect(approved.length).toBeGreaterThan(0);
    const all = await src.createResultSet(f({ project: NB, includeUnreviewed: true }));
    expect(all).toMatchObject({ id: 'rs_2', count: 13, locatedCount: 11, unlocatedCount: 2, excludedUnreviewed: 0 });
    // The bbox is the located members'.
    expect(all.bbox).toEqual(boundsOf(nb));
    expect(typeof all.createdAt).toBe('string');
  });

  it('search finds IDs and printed IDs; an unplotted member counts as unlocated and leaves the bbox null', async () => {
    const src = createSampleSource();
    await expect(src.createResultSet(f({ search: 'bk 7', includeUnreviewed: true }))).resolves.toMatchObject({ count: 1, uids: ['nb:BK-07'] });
    await expect(src.createResultSet(f({ search: 'SK-05', includeUnreviewed: true }))).resolves.toMatchObject({
      count: 1, locatedCount: 0, unlocatedCount: 1, bbox: null,
    });
  });

  it('depth range, DIN codes with lithology_min_depth, SPT, groundwater, review status and document filter like the backend', async () => {
    const src = createSampleSource();
    const { boreholes } = await everything(src);
    const run = (o: Partial<BoreholeFilter>) => src.createResultSet(f({ includeUnreviewed: true, ...o })).then((rs) => rs.uids);
    expect(await run({ minDepth: 20, maxDepth: 25 })).toEqual(uidsOf(boreholes.filter((b) => b.finalDepth != null && b.finalDepth >= 20 && b.finalDepth <= 25)));
    expect(await run({ dinCodes: ['Sst'] })).toEqual(uidsOf(boreholes.filter((b) => b.layers.some((l) => l.din === 'Sst'))));
    expect(await run({ dinCodes: ['Sst'], lithologyMinDepth: 14 })).toEqual(
      uidsOf(boreholes.filter((b) => b.layers.some((l) => l.din === 'Sst' && l.to > 14))),
    );
    expect(await run({ hasSpt: false })).toEqual(uidsOf(boreholes.filter((b) => !b.layers.some((l) => l.spt))));
    expect(await run({ hasGroundwater: true })).toHaveLength(48);
    expect(await run({ hasGroundwater: false })).toEqual([]);
    expect(await run({ reviewStatus: ['unreviewed'] })).toEqual(uidsOf(boreholes.filter((b) => b.reviewStatus === 'unreviewed')));
    expect(await run({ documentId: 'eq' })).toHaveLength(9);
    // The sample states no country: a country filter matches nothing (unknown never matches).
    expect(await run({ country: 'Example Land' })).toEqual([]);
  });

  it('areas: a bbox, a polygon and a circle select by position', async () => {
    const src = createSampleSource();
    const { features } = await everything(src);
    const bbox: [number, number, number, number] = [9.15, 48.77, 9.25, 48.82];
    const rsBbox = await src.createResultSet(f({ includeUnreviewed: true, area: { type: 'bbox', bbox } }));
    const inBbox = features.filter((x) => x.lng >= bbox[0] && x.lng <= bbox[2] && x.lat >= bbox[1] && x.lat <= bbox[3]);
    expect(rsBbox.uids).toEqual(inBbox.map((x) => x.uid).sort());
    expect(rsBbox.uids).toHaveLength(11);
    expect(rsBbox.area).toEqual({ type: 'bbox', bbox });
    // A triangle around the Elbquerung site.
    const triangle = { type: 'Polygon' as const, coordinates: [[[9.9, 53.45], [10.2, 53.45], [10.05, 53.65], [9.9, 53.45]]] };
    const rsPolygon = await src.createResultSet(f({ includeUnreviewed: true, area: { type: 'polygon', polygon: triangle } }));
    expect(rsPolygon).toMatchObject({ count: 9, locatedCount: 9 });
    expect(rsPolygon.uids.every((uid) => uid.startsWith('eq:'))).toBe(true);
    // 500 m around BK-07: the pins within that distance, BK-07 among them.
    const center: [number, number] = [9.1835, 48.7905];
    const rsCircle = await src.createResultSet(f({ includeUnreviewed: true, area: { type: 'circle', center, radiusM: 500 } }));
    const near = features.filter((x) => haversineM(center, [x.lng, x.lat]) <= 500).map((x) => x.uid).sort();
    expect(rsCircle.uids).toEqual(near);
    expect(near).toContain('nb:BK-07');
    expect(near.length).toBeLessThan(11);
  });

  it('an area without boreholes has the area as bbox; a circle without a radius is refused', async () => {
    const src = createSampleSource();
    const area = { type: 'bbox' as const, bbox: [10.97, 47.58, 11.07, 47.64] as [number, number, number, number] };
    await expect(src.createResultSet(f({ area }))).resolves.toMatchObject({ count: 0, uids: [], bbox: areaBbox(area), area });
    const e = await failure(src.createResultSet(f({ area: { type: 'circle', center: [9, 48], radiusM: 0 } })));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 422, code: 'validation_error', errors: [{ loc: ['body', 'area', 'radius_m'] }] });
  });

  it('stores the set: getResultSet by id, its placed members as features; an unknown id is result_set_not_found', async () => {
    const src = createSampleSource();
    const rs = await src.createResultSet(f({ project: NB, includeUnreviewed: true }));
    await expect(src.getResultSet(rs.id)).resolves.toEqual(rs);
    const pins = await src.resultSetFeatures(rs.id);
    expect(pins).toHaveLength(11);
    expect(pins.map((x) => x.uid)).toEqual(rs.uids.filter((uid) => !/BK-1[34]$/.test(uid)));
    for (const call of [src.getResultSet('rs_404'), src.resultSetFeatures('rs_404')]) {
      await expect(call).rejects.toMatchObject({ name: 'ApiError', status: 404, code: 'result_set_not_found' });
    }
  });
});

describe('place search (fictional gazetteer)', () => {
  it('lists uploaded project sites first with their borehole counts, then towns', async () => {
    const places = await createSampleSource().geocode('Neckar');
    expect(places.map((p) => [p.label, p.source, p.boreholeCount])).toEqual([
      [`${NB} project site (uploaded)`, 'uploaded', 11],
      ['Neckarweiler (fictional town)', 'geocoder', 11],
    ]);
    expect(places[0]).toMatchObject({ kind: 'project_site' });
    expect(places[0].bbox).not.toBeNull();
  });

  it('a town without uploaded boreholes says so with 0; an unknown place gives []; a one-letter query is refused', async () => {
    const src = createSampleSource();
    await expect(src.geocode('lindenfurt')).resolves.toMatchObject([{ label: 'Lindenfurt (fictional town)', boreholeCount: 0, source: 'geocoder' }]);
    await expect(src.geocode('Atlantis')).resolves.toEqual([]);
    await expect(src.geocode(' x ')).rejects.toMatchObject({ status: 422, code: 'validation_error' });
  });
});

describe('clarifications: the questions make the open-question counts', () => {
  it('every Neckarbogen borehole has one (the shared CRS question), MS-05 two (datum, depth unit), EM-04 and CL-04 one each, nothing else', async () => {
    const src = createSampleSource();
    const { boreholes } = await everything(src);
    for (const b of boreholes) {
      const expected = b.id === 'MS-05' ? 2 : b.documentId === 'nb' || ['EM-04', 'CL-04'].includes(b.id) ? 1 : 0;
      expect(b.openClarifications, b.id).toBe(expected);
    }
    const { documents } = await src.load();
    expect(documents.map((d) => [d.id, d.openClarifications])).toEqual([['nb', 1], ['eq', 0], ['is', 0]]);
  });

  it('lists five open questions oldest first, of different kinds, for the boreholes they count against', async () => {
    const src = createSampleSource();
    const { boreholes } = await everything(src);
    const list = await src.clarifications();
    expect(list.map((q) => [q.kind, q.status])).toEqual([
      ['crs_confirm', 'open'], ['datum_convention', 'open'], ['choose_reading', 'open'], ['locate_borehole', 'open'], ['unit_ambiguous', 'open'],
    ]);
    expect([...list.map((q) => q.createdAt)].sort()).toEqual(list.map((q) => q.createdAt));
    expect(list[0].boreholeUids.sort()).toEqual(uidsOf(boreholes.filter((b) => b.documentId === 'nb')));
    expect(list.slice(1).map((q) => q.boreholeUids.map((uid) => byId(boreholes, uid.split(':')[1]).id))).toEqual([['MS-05'], ['EM-04'], ['CL-04'], ['MS-05']]);
    await expect(src.clarifications({ documentId: 'nb' })).resolves.toHaveLength(1);
    await expect(src.clarifications({ status: 'skipped' })).resolves.toEqual([]);
    await expect(src.clarifications({ status: 'answered' })).resolves.toEqual([]);
  });

  it('the CRS question offers the candidates of the report (codes and labels) and a swap-axes flag defaulting to false', async () => {
    const src = createSampleSource();
    const q = await question(src, 'crs_confirm');
    const candidates = await src.crsCandidates('nb');
    expect(q.fields.map((x) => [x.name, x.widget, x.required, x.default])).toEqual([['crs', 'crs_picker', true, undefined], ['swap_axes', 'boolean', false, false]]);
    expect(q.fields[0].options.map((o) => [o.value, o.label])).toEqual(candidates.map((c) => [c.code, c.name]));
  });

  it('together the fields use every widget; every question and option has evidence on a sample page that renders', async () => {
    const src = createSampleSource();
    const list = await src.clarifications();
    expect(new Set(list.flatMap((q) => q.fields.map((x) => x.widget)))).toEqual(
      new Set(['text', 'number_unit', 'select', 'boolean', 'map_point', 'choose_reading', 'page_range', 'crs_picker']),
    );
    const reading = list.find((q) => q.kind === 'choose_reading') as Clarification;
    expect(reading.fields[0].options.every((o) => o.evidence?.box && o.evidence.snippet)).toBe(true);
    for (const q of list) {
      expect(q.evidence.length, q.id).toBeGreaterThan(0);
      for (const e of [...q.evidence, ...q.fields.flatMap((x) => x.options.flatMap((o) => (o.evidence ? [o.evidence] : [])))]) {
        const page = await src.getPage(e.documentId, e.page);
        expect(page.items?.length, `${q.id} page ${e.page}`).toBeGreaterThan(0);
        expect(e.box, q.id).not.toBeNull();
        if (e.box) expect([e.box.x + e.box.w <= 1, e.box.y + e.box.h <= 1]).toEqual([true, true]);
      }
    }
  });
});

describe('clarifications: answer checks', () => {
  it('a missing required field is a 422 answer_invalid with its error at [values, field]; nothing changes', async () => {
    const { src, events } = recorded();
    const q = await question(src, 'crs_confirm');
    const e = await failure(src.answerClarification(q.id, { swap_axes: false }, null));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({
      status: 422, code: 'answer_invalid', detail: "The answer does not match the question's fields.",
      errors: [{ loc: ['values', 'crs'], msg: 'Coordinate system is required.' }],
    });
    expect(events).toEqual([]);
    await expect(src.clarifications()).resolves.toHaveLength(5);
  });

  it('every field is checked against its widget: options, booleans, points {lat, lon}, numbers with units, page ranges, unknown fields', async () => {
    const src = createSampleSource();
    const list = await src.clarifications();
    const [crs, datum, reading, locate] = list;
    const errorsOf = async (q: Clarification, values: Record<string, unknown>) =>
      ((await failure(src.answerClarification(q.id, values, null))) as ApiError).errors.map((x) => x.loc.join('.'));
    expect(await errorsOf(crs, { crs: 'EPSG:4326', swap_axes: 'no' })).toEqual(['values.crs', 'values.swap_axes']);
    expect(await errorsOf(datum, { datum: 'Mean sea level', note: 42, colour: 'red' })).toEqual(['values.colour', 'values.datum', 'values.note']);
    expect(await errorsOf(reading, { reading: 99, pages: [3, 1] })).toEqual(['values.reading', 'values.pages']);
    expect(await errorsOf(locate, { location: { lat: 51.3, lng: 12.4 }, accuracy: { value: 5, unit: 'yd' } })).toEqual(['values.location', 'values.accuracy']);
    expect(await errorsOf(locate, { location: { lat: 91, lon: 12.4 } })).toEqual(['values.location']);
    await expect(src.clarifications()).resolves.toHaveLength(5);
  });

  it('an unknown question is clarification_not_found; an answered one is already_resolved for answer and skip', async () => {
    const src = createSampleSource();
    await expect(src.answerClarification('cl_nope', {}, null)).rejects.toMatchObject({ status: 404, code: 'clarification_not_found' });
    await expect(src.skipClarification('cl_nope')).rejects.toMatchObject({ status: 404, code: 'clarification_not_found' });
    const q = await question(src, 'datum_convention');
    await src.answerClarification(q.id, { datum: 'NHN (DHHN2016)' }, null);
    await expect(src.answerClarification(q.id, { datum: 'NHN (DHHN92)' }, null)).rejects.toMatchObject({ status: 409, code: 'already_resolved' });
    await expect(src.skipClarification(q.id)).rejects.toMatchObject({ status: 409, code: 'already_resolved' });
  });
});

describe('clarifications: skip and answer', () => {
  it('skip leaves the question unresolved: listed as skipped, counts and badges kept, one clarification.resolved event', async () => {
    const { src, events } = recorded();
    const q = await question(src, 'choose_reading');
    const before = await everything(src);
    await expect(src.skipClarification(q.id)).resolves.toMatchObject({ id: q.id, status: 'skipped', answer: null, resolvedAt: null });
    expect(events).toEqual([{ type: 'clarification.resolved', clarificationId: q.id, status: 'skipped' }]);
    expect((await src.clarifications()).map((x) => x.id)).not.toContain(q.id);
    expect((await src.clarifications({ status: 'skipped' })).map((x) => x.id)).toEqual([q.id]);
    expect(await everything(src)).toEqual(before);
    // Skipping again changes nothing; a skipped question can still be answered.
    await src.skipClarification(q.id);
    expect(events).toHaveLength(1);
    await expect(src.answerClarification(q.id, { reading: q.fields[0].options[0].value }, null)).resolves.toMatchObject({ status: 'answered' });
  });

  it('the CRS answer confirms the system for the question\'s boreholes, like the CRS dialog, and plots them', async () => {
    const { src, events } = recorded();
    const q = await question(src, 'crs_confirm');
    const answered = await src.answerClarification(q.id, { crs: 'EPSG:31467', swap_axes: false }, '  A. Reviewer (fictional)  ');
    expect(answered).toMatchObject({ status: 'answered', answer: { crs: 'EPSG:31467', swap_axes: false }, answeredBy: 'A. Reviewer (fictional)' });
    expect(answered.resolvedAt).toEqual(expect.any(String));
    const { boreholes, features } = await everything(src);
    const nb = boreholes.filter((b) => b.documentId === 'nb');
    expect(nb.every((b) => b.openClarifications === 0 && b.revision === 2)).toBe(true);
    expect(nb.filter((b) => b.crs.status === 'confirmed').map((b) => b.id)).toHaveLength(11);
    expect(byId(boreholes, 'BK-13').crs.status).toBe('inferred');
    expect(legend(features).attention).toBe(4);
    expect(events[0]).toEqual({ type: 'clarification.resolved', clarificationId: q.id, status: 'answered' });
    expect(events.filter((e) => e.type === 'borehole.updated')).toHaveLength(13);
    expect(events.filter((e) => e.type === 'borehole.updated').every((e) => e.type === 'borehole.updated' && e.revision === 2)).toBe(true);
    expect(events.filter((e) => e.type === 'document.updated')).toMatchObject([{ document: { id: 'nb', openClarifications: 0 } }]);
    // Without a name nothing is invented.
    const other = createSampleSource();
    const crs = await question(other, 'crs_confirm');
    await expect(other.answerClarification(crs.id, { crs: 'EPSG:31468' }, null)).resolves.toMatchObject({ answeredBy: null });
  });

  it('a CRS that cannot place the boreholes is crs_invalid and changes nothing', async () => {
    const { src, events } = recorded();
    const q = await question(src, 'crs_confirm');
    await expect(src.answerClarification(q.id, { crs: 'EPSG:25832' }, null)).rejects.toMatchObject({ status: 422, code: 'crs_invalid' });
    await expect(src.answerClarification(q.id, { crs: 'EPSG:31467', swap_axes: true }, null)).rejects.toMatchObject({ status: 422, code: 'crs_invalid' });
    expect(events).toEqual([]);
    await expect(src.clarifications()).resolves.toHaveLength(5);
  });

  it('the datum answer sets the datum, settles the datum warning and lowers MS-05\'s count (its unit question stays); no queue document changes', async () => {
    const { src, events } = recorded();
    const q = await question(src, 'datum_convention');
    await src.answerClarification(q.id, { datum: 'NHN (DHHN2016)', note: 'Stated in the client brief (fictional)' }, null);
    const { boreholes, features } = await everything(src);
    const ms5 = byId(boreholes, 'MS-05');
    expect(ms5).toMatchObject({ openClarifications: 1, revision: 2, meta: { elevationDatum: 'NHN (DHHN2016)' } });
    const elevation = ms5.values.find((v) => v.key === K.elevation);
    expect([elevation?.note, elevation?.lint]).toEqual(['datum: NHN (DHHN2016)', undefined]);
    // The depth-unit question is still open, so MS-05 keeps its attention.
    expect(displayStatus(ms5)).toBe('attention');
    expect(legend(features)).toEqual({ approved: 23, in_review: 0, unreviewed: 8, attention: 14 });
    expect(events.map((e) => e.type)).toEqual(['clarification.resolved', 'borehole.updated']);
  });

  it('the chosen reading sets and approves the final depth (edited when it differs)', async () => {
    const src = createSampleSource();
    const q = await question(src, 'choose_reading');
    const [first, second] = q.fields[0].options.map((o) => o.value as number);
    expect(second).toBeCloseTo(first + 5);
    await src.answerClarification(q.id, { reading: second, pages: q.fields[1].default }, null);
    const em4 = (await everything(src)).boreholes.find((b) => b.id === 'EM-04') as Borehole;
    expect(em4.finalDepth).toBe(second);
    expect(em4.values.find((v) => v.key === K.finalDepth)).toMatchObject({ value: second.toFixed(2), method: 'Edited', status: 'approved', aiValue: first.toFixed(2) });
    expect(em4).toMatchObject({ openClarifications: 0, reviewStatus: 'in_review', revision: 2 });
    expect((await src.mapFeatures()).find((x) => x.id === 'EM-04')).toMatchObject({ depth: second, attention: false, reviewStatus: 'in_review' });
  });

  it('the located position moves CL-04; a number with its unit is accepted', async () => {
    const src = createSampleSource();
    const q = await question(src, 'locate_borehole');
    await src.answerClarification(q.id, { location: { lat: 51.3341, lon: 12.3802 }, accuracy: { value: 5, unit: 'm' } }, null);
    const cl4 = (await everything(src)).boreholes.find((b) => b.id === 'CL-04') as Borehole;
    expect(cl4).toMatchObject({ lat: 51.3341, lng: 12.3802, onMap: true, openClarifications: 0, revision: 2 });
  });

  it('after every question is answered, no borehole and no document has an open question', async () => {
    const src = createSampleSource();
    const answers: Record<string, Record<string, unknown>> = {
      crs_confirm: { crs: 'EPSG:31467' }, datum_convention: { datum: 'NN (DHHN12)' }, choose_reading: { reading: 0 }, locate_borehole: { location: { lat: 51.34, lon: 12.38 } },
      unit_ambiguous: { depth: { value: 12, unit: 'm' } },
    };
    for (const q of await src.clarifications()) {
      const values = q.kind === 'choose_reading' ? { reading: q.fields[0].options[0].value } : answers[q.kind];
      await src.answerClarification(q.id, values, null);
    }
    const { boreholes, features } = await everything(src);
    expect(boreholes.filter((b) => b.openClarifications > 0)).toEqual([]);
    expect((await src.load()).documents.map((d) => d.openClarifications)).toEqual([0, 0, 0]);
    expect(features.filter((x) => x.attention).map((x) => x.id)).toEqual(['BK-07']);
    await expect(src.clarifications({ status: 'answered' })).resolves.toHaveLength(5);
  });
});
