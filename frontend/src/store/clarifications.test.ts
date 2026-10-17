/**
 * Clarification questions in the store (F12) with fake sources (fictional questions): loading open
 * and skipped ones, live events, the dialog, answering (with the reviewer's name, refreshes, 422
 * field errors, 409 already answered) and skipping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { ApiError } from '../data/errors';
import type { Clarification } from '../domain/types';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { useAppStore } from './appStore';
import { ALREADY_ANSWERED, fieldErrorsOf, oldestFirst, QUESTION_GONE } from './clarificationsSlice';
import { fakeSource, makeClarification, manualLive, readyStore, settle } from './testing';

const st = () => useAppStore.getState();

const DOC = 'doc_TEST0000000000000000000001';
const DOC2 = 'doc_TEST0000000000000000000002';
const A = makeBorehole({ uid: 'bh_TEST_A', id: 'TB-01' });
const OFF = makeBorehole({ uid: 'bh_TEST_OFF', id: 'TB-03', onMap: false, lat: null, lng: null, unplottedReason: 'crs_unconfirmed', crs: { name: null, code: null, status: 'inferred' } });
const OTHER = makeBorehole({ uid: 'bh_TEST_OTHER', id: 'XY-7', documentId: DOC2, lat: -36.8, lng: 174.7 });

const crsQuestion = makeClarification({
  id: 'cl_TEST_CRS',
  kind: 'crs_confirm',
  documentId: DOC,
  boreholeUids: [OFF.uid, A.uid],
  question: 'Which coordinate system do the fictional coordinates use?',
  fields: [
    { name: 'crs', widget: 'crs_picker', label: 'Coordinate system', help: null, required: true, unitOptions: [], options: [], default: undefined },
    { name: 'swap_axes', widget: 'boolean', label: 'Swap axes', help: null, required: false, unitOptions: [], options: [], default: false },
  ],
  createdAt: '2026-10-17T08:00:00Z',
});
const unitQuestion = makeClarification({ id: 'cl_TEST_UNIT', documentId: DOC2, boreholeUids: [OTHER.uid], createdAt: '2026-10-17T07:00:00Z' });
const skippedQuestion = makeClarification({ id: 'cl_TEST_SKIP', documentId: DOC, status: 'skipped', createdAt: '2026-10-17T07:30:00Z' });
const answeredQuestion = makeClarification({ id: 'cl_TEST_DONE', documentId: DOC, status: 'answered', createdAt: '2026-10-17T06:00:00Z' });

async function ready(over: Partial<DataSource> = {}, questions: Clarification[] = [crsQuestion, unitQuestion, skippedQuestion, answeredQuestion]) {
  const fake = fakeSource({ boreholes: [A, OFF, OTHER], documents: [makeDocument({ id: DOC }), makeDocument({ id: DOC2, name: 'second.pdf' })], clarifications: questions }, over);
  await readyStore(fake, null, { cache: 'boot' });
  return fake;
}

afterEach(() => {
  useAppStore.setState({ reviewerName: null });
});

describe('loading', () => {
  it('loads open and skipped questions (one call per status), oldest first; answered ones stay out', async () => {
    const fake = await ready();
    const clarifications = vi.fn(fake.clarifications);
    fake.clarifications = clarifications;
    const loading = st().loadClarifications();
    expect(st().clarificationsState).toBe('loading');
    await loading;
    expect(clarifications.mock.calls.map(([o]) => o?.status).sort()).toEqual(['open', 'skipped']);
    expect(st().clarifications.map((c) => c.id)).toEqual(['cl_TEST_UNIT', 'cl_TEST_SKIP', 'cl_TEST_CRS']);
    expect(st().clarificationsState).toBe('ready');
  });

  it('a failed load says so and keeps what the list had', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = await ready();
    await st().loadClarifications();
    fake.clarifications = () => Promise.reject(new Error('offline'));
    await st().loadClarifications();
    expect(st().clarificationsState).toBe('error');
    expect(st().clarifications).toHaveLength(3);
    warn.mockRestore();
  });

  it('a question that arrives live while the list loads stays; one answered meanwhile does not come back', async () => {
    const live = manualLive();
    let answer: (c: Clarification[]) => void = () => undefined;
    const fake = await ready({ subscribe: live.subscribe });
    st().startLive();
    const real = fake.clarifications;
    fake.clarifications = (o) => (o?.status === 'open' ? new Promise((r) => (answer = r)) : real(o));
    const loading = st().loadClarifications();
    const fresh = makeClarification({ id: 'cl_TEST_NEW', documentId: DOC, createdAt: '2026-10-17T09:00:00Z' });
    live.emit({ type: 'clarification.created', clarification: fresh });
    await st().answerClarification('cl_TEST_UNIT', { unit: 'm' });
    answer([structuredClone(crsQuestion), structuredClone(unitQuestion)]);
    await loading;
    expect(st().clarifications.map((c) => c.id)).toEqual(['cl_TEST_SKIP', 'cl_TEST_CRS', 'cl_TEST_NEW']);
  });
});

describe('live events', () => {
  it('clarification.created adds the question once; clarification.resolved (answered) removes it', async () => {
    const live = manualLive();
    await ready({ subscribe: live.subscribe }, []);
    st().startLive();
    const q = makeClarification({ id: 'cl_TEST_LIVE', documentId: DOC, boreholeUids: [A.uid] });
    live.emit({ type: 'clarification.created', clarification: q }, { type: 'clarification.created', clarification: q });
    expect(st().clarifications.map((c) => c.id)).toEqual(['cl_TEST_LIVE']);
    st().openClarification('cl_TEST_LIVE');
    live.emit({ type: 'clarification.resolved', clarificationId: 'cl_TEST_LIVE', status: 'answered' });
    expect(st().clarifications).toEqual([]);
    // Answered elsewhere: the dialog showing it closes.
    expect(st().activeClarificationId).toBeNull();
  });
});

describe('the dialog', () => {
  it('opens and closes on a question', async () => {
    await ready();
    st().openClarification('cl_TEST_CRS');
    expect(st().activeClarificationId).toBe('cl_TEST_CRS');
    st().closeClarification();
    expect(st().activeClarificationId).toBeNull();
  });
});

describe('answering', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('sends the values with your name; the question leaves the list and the dialog closes', async () => {
    const fake = await ready();
    const answerClarification = vi.fn(fake.answerClarification);
    fake.answerClarification = answerClarification;
    await st().loadClarifications();
    st().setReviewerName('  A. Reviewer ');
    st().openClarification('cl_TEST_CRS');
    expect(await st().answerClarification('cl_TEST_CRS', { crs: 'EPSG:0001', swap_axes: false })).toEqual({ ok: true });
    expect(answerClarification).toHaveBeenCalledWith('cl_TEST_CRS', { crs: 'EPSG:0001', swap_axes: false }, 'A. Reviewer');
    expect(st().clarifications.map((c) => c.id)).toEqual(['cl_TEST_UNIT', 'cl_TEST_SKIP']);
    expect(st().activeClarificationId).toBeNull();
  });

  it('sends no name when none is set', async () => {
    const fake = await ready();
    const answerClarification = vi.fn(fake.answerClarification);
    fake.answerClarification = answerClarification;
    st().setReviewerName('');
    await st().answerClarification('cl_TEST_UNIT', { unit: 'm' });
    expect(answerClarification.mock.calls[0][2]).toBeNull();
  });

  it('then refreshes the affected cached records, the document and the map: a CRS answer can place a whole file', async () => {
    const fake = await ready();
    await st().loadClarifications();
    const getBorehole = vi.fn(fake.getBorehole);
    const getDocument = vi.fn(fake.getDocument);
    const mapFeatures = vi.fn(fake.mapFeatures);
    const unplotted = vi.fn(fake.unplotted);
    Object.assign(fake, { getBorehole, getDocument, mapFeatures, unplotted });
    // The server places the borehole when the answer lands.
    const real = fake.answerClarification;
    fake.answerClarification = async (id, values, by) => {
      fake.held.set(OFF.uid, { ...OFF, revision: 2, onMap: true, lat: 51, lng: 7, unplottedReason: null, crs: { name: null, code: 'EPSG:0001', status: 'confirmed' } });
      return real(id, values, by);
    };
    expect(await st().answerClarification('cl_TEST_CRS', { crs: 'EPSG:0001' })).toEqual({ ok: true });
    // Only the cached record (the unplotted one) is refetched; the pin-only borehole comes with the map.
    await vi.waitFor(() => expect(getBorehole).toHaveBeenCalledWith(OFF.uid));
    expect(getBorehole).not.toHaveBeenCalledWith(A.uid);
    await vi.waitFor(() => expect(getDocument).toHaveBeenCalledWith(DOC));
    await vi.waitFor(() => expect(st().unplottedUids).toEqual([]));
    expect(mapFeatures).toHaveBeenCalledWith();
    expect(unplotted).toHaveBeenCalled();
    expect(st().features.find((f) => f.uid === OFF.uid)).toMatchObject({ lat: 51, lng: 7 });
    expect(st().boreholes.find((b) => b.uid === OFF.uid)).toMatchObject({ revision: 2, onMap: true });
  });

  it('a 422 comes back as field errors by field name, with the server’s detail as the message; the question stays', async () => {
    const errors = [
      { loc: ['body', 'values', 'crs'], msg: 'Not one of the offered systems.' },
      { loc: ['body', 'values', 'swap_axes'], msg: 'Must be true or false.' },
      { loc: ['body', 'values'], msg: 'The answer is incomplete.' },
    ];
    await ready({ answerClarification: () => Promise.reject(new ApiError(422, 'answer_invalid', 'The answer does not fit the question.', errors)) });
    await st().loadClarifications();
    st().openClarification('cl_TEST_CRS');
    expect(await st().answerClarification('cl_TEST_CRS', { crs: 'EPSG:9999', swap_axes: 'maybe' })).toEqual({
      ok: false,
      message: 'The answer does not fit the question.',
      fieldErrors: { crs: 'Not one of the offered systems.', swap_axes: 'Must be true or false.' },
    });
    expect(st().clarifications.map((c) => c.id)).toContain('cl_TEST_CRS');
    expect(st().activeClarificationId).toBe('cl_TEST_CRS');
  });

  it('a 409 already_resolved takes the question out and says it was answered elsewhere', async () => {
    const fake = await ready();
    await st().loadClarifications();
    fake.questions.set('cl_TEST_CRS', { ...crsQuestion, status: 'answered' });
    st().openClarification('cl_TEST_CRS');
    expect(await st().answerClarification('cl_TEST_CRS', { crs: 'EPSG:0001' })).toEqual({ ok: false, message: ALREADY_ANSWERED, fieldErrors: {} });
    expect(st().clarifications.map((c) => c.id)).not.toContain('cl_TEST_CRS');
    expect(st().activeClarificationId).toBeNull();
    expect(st().toast?.text).toBe(ALREADY_ANSWERED);
  });

  it('a question the server no longer knows (404) leaves the list too', async () => {
    await ready({ answerClarification: () => Promise.reject(new ApiError(404, 'clarification_not_found', 'Not found.')) });
    await st().loadClarifications();
    expect(await st().answerClarification('cl_TEST_UNIT', { unit: 'm' })).toMatchObject({ ok: false, message: QUESTION_GONE });
    expect(st().clarifications.map((c) => c.id)).not.toContain('cl_TEST_UNIT');
  });

  it('any other failure keeps the question and gives the reason', async () => {
    await ready({ answerClarification: () => Promise.reject(new Error('Backend unreachable')) });
    await st().loadClarifications();
    expect(await st().answerClarification('cl_TEST_UNIT', { unit: 'm' })).toEqual({ ok: false, message: 'Backend unreachable', fieldErrors: {} });
    expect(st().clarifications.map((c) => c.id)).toContain('cl_TEST_UNIT');
  });

  it('a skipped question can still be answered', async () => {
    await ready();
    await st().loadClarifications();
    expect(await st().answerClarification('cl_TEST_SKIP', { unit: 'm' })).toEqual({ ok: true });
    expect(st().clarifications.map((c) => c.id)).toEqual(['cl_TEST_UNIT', 'cl_TEST_CRS']);
  });
});

describe('skipping', () => {
  it('marks the question skipped in the list (still unresolved) and closes the dialog', async () => {
    const fake = await ready();
    const skipClarification = vi.fn(fake.skipClarification);
    fake.skipClarification = skipClarification;
    await st().loadClarifications();
    st().openClarification('cl_TEST_CRS');
    await st().skipClarification('cl_TEST_CRS');
    expect(skipClarification).toHaveBeenCalledWith('cl_TEST_CRS');
    expect(st().clarifications.map((c) => [c.id, c.status])).toEqual([
      ['cl_TEST_UNIT', 'open'],
      ['cl_TEST_SKIP', 'skipped'],
      ['cl_TEST_CRS', 'skipped'],
    ]);
    expect(st().activeClarificationId).toBeNull();
  });

  it('a failed skip keeps the question as it was and says why', async () => {
    await ready({ skipClarification: () => Promise.reject(new Error('offline')) });
    await st().loadClarifications();
    await st().skipClarification('cl_TEST_CRS');
    expect(st().clarifications.find((c) => c.id === 'cl_TEST_CRS')?.status).toBe('open');
    expect(st().toast?.text).toBe('Not skipped: offline');
  });

  it('a question answered elsewhere leaves the list when skipped', async () => {
    const fake = await ready();
    await st().loadClarifications();
    fake.questions.set('cl_TEST_UNIT', { ...unitQuestion, status: 'answered' });
    await st().skipClarification('cl_TEST_UNIT');
    await settle();
    expect(st().clarifications.map((c) => c.id)).not.toContain('cl_TEST_UNIT');
    expect(st().toast?.text).toBe(ALREADY_ANSWERED);
  });
});

describe('helpers', () => {
  it('fieldErrorsOf takes the field from the end of loc (an index may follow it), only fields of the question', () => {
    const fields = crsQuestion.fields;
    expect(
      fieldErrorsOf(
        [
          { loc: ['body', 'values', 'crs', 0], msg: 'First.' },
          { loc: ['body', 'values', 'crs'], msg: 'Second.' },
          { loc: ['body', 'values', 'unknown_field'], msg: 'Ignored.' },
          { loc: [], msg: 'Ignored too.' },
        ],
        fields,
      ),
    ).toEqual({ crs: 'First.; Second.' });
    // Without the question's fields, the last name in loc counts.
    expect(fieldErrorsOf([{ loc: ['body', 'values', 'depth'], msg: 'Too deep.' }])).toEqual({ depth: 'Too deep.' });
  });

  it('oldestFirst sorts by creation time and keeps the order of equal times', () => {
    const a = makeClarification({ id: 'a', createdAt: '2026-10-17T08:00:00Z' });
    const b = makeClarification({ id: 'b', createdAt: '2026-10-17T07:00:00Z' });
    const c = makeClarification({ id: 'c', createdAt: '2026-10-17T08:00:00Z' });
    expect(oldestFirst([a, b, c]).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });
});
