/**
 * What the transcript's buttons do (FRONTEND.md F14), on a store over a fake source with fictional
 * data: SHOW ON MAP / OPEN TABLE show the set with a flight and go to the map, a citation chip opens
 * the Source panel (the cited value's source, or the cited page and box), a question card's ANSWER
 * opens the question dialog.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import { useAppStore } from '../store/appStore';
import { fakeSource, readyStore, type FakeSource } from '../store/testing';
import { EXAMPLES } from '../test/contract/examples';
import { makeBorehole, makeDocument, makeValue } from '../test/fixtures';
import { answerQuestion, openCitation, openSetTable, showSetOnMap } from './cardActions';
import type { Citation } from './types';

const st = () => useAppStore.getState();
const DOC = makeDocument().id;
const A = makeBorehole({
  uid: 'bh_TEST_CARD_0000000000000001',
  lat: 50,
  lng: 8,
  values: [makeValue({ key: K.finalDepth, value: '6.00', page: 1, box: { x: 0.1, y: 0.8, w: 0.2, h: 0.03 } })],
});

let source: FakeSource;

beforeEach(async () => {
  source = fakeSource({ boreholes: [A], documents: [makeDocument()] });
  await readyStore(source);
});

const citation = (o: Partial<Citation> = {}): Citation => ({ id: 'c1', documentId: DOC, page: 4, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, uid: null, path: null, snippet: '', ...o });

describe('result card', () => {
  it('SHOW ON MAP goes to the map, shows the set and flies to it', async () => {
    const rs = await source.createResultSet({ ...st().filter });
    st().go('queue');
    await showSetOnMap(rs.id);
    expect(st().screen).toBe('map');
    expect(st().resultSet?.id).toBe(rs.id);
    expect(st().mapOutline).toMatchObject({ bbox: [8, 50, 8, 50], outline: false });
  });

  it('OPEN TABLE does the same (the focus goes to the RESULTS table in the app)', async () => {
    const rs = await source.createResultSet({ ...st().filter });
    st().go('queue');
    await openSetTable(rs.id);
    expect(st().screen).toBe('map');
    expect(st().resultSet?.id).toBe(rs.id);
  });
});

describe('citation chip', () => {
  it('opens the cited page with the cited box', async () => {
    await openCitation(citation());
    expect(st().panel).toEqual({ kind: 'source', documentId: DOC, page: 4, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } });
  });

  it('with uid and path opens that value’s source', async () => {
    await openCitation(citation({ uid: A.uid, path: 'metadata.borehole_depth_m', page: 1 }));
    expect(st().panel).toMatchObject({ kind: 'source', uid: A.uid, key: K.finalDepth, page: 1 });
  });

  it('with a path the borehole has no value for, opens the cited page', async () => {
    await openCitation(citation({ uid: A.uid, path: 'metadata.client' }));
    expect(st().panel).toMatchObject({ kind: 'source', documentId: DOC, page: 4 });
    expect(st().panel).not.toHaveProperty('uid');
  });
});

describe('question card', () => {
  it('ANSWER opens the dialog of the question the chat sent', () => {
    answerQuestion(EXAMPLES['Clarification.chat_parameter.json']);
    expect(st().activeClarificationId).toBe('cl_01M54KRVZ0RQTZ7G7JZHNWC84E');
  });

  it('a question this client cannot show says where to find it', () => {
    answerQuestion({ question: 'no id' });
    expect(st().activeClarificationId).toBeNull();
    expect(st().toast?.text).toContain('INBOX');
  });
});
