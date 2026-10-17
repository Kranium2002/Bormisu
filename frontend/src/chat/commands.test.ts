/**
 * The UI command dispatcher (FRONTEND.md F15, contracts/realtime-and-chat.md 2.3) on a store over a
 * fake source with fictional data: every allowlisted command acts through the store's own actions,
 * coordinates are taken only from fit_bounds.bbox, and anything else is ignored with one console.info.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { K } from '../domain/keys';
import { useAppStore } from '../store/appStore';
import { fakeSource, makeClarification, readyStore, settle, type FakeSource } from '../store/testing';
import { EXAMPLES } from '../test/contract/examples';
import { makeBorehole, makeDocument, makeValue } from '../test/fixtures';
import { openChatClarification, runUiCommand } from './commands';

const st = () => useAppStore.getState();

const DOC = makeDocument().id;
const A = makeBorehole({
  uid: 'bh_TEST_CHAT_0000000000000001',
  id: 'CH-1',
  lat: 50,
  lng: 8,
  finalDepth: 12,
  values: [
    makeValue({ key: K.boreholeId, value: 'CH-1' }),
    makeValue({ key: K.finalDepth, value: '12.00', unit: 'm', page: 1, box: { x: 0.1, y: 0.8, w: 0.2, h: 0.03 } }),
    makeValue({ key: K.bottom(2), group: 'layer', layer: 2, value: '6.00', unit: 'm', page: 1, box: { x: 0.1, y: 0.4, w: 0.2, h: 0.03 } }),
  ],
});
const B = makeBorehole({ uid: 'bh_TEST_CHAT_0000000000000002', id: 'CH-2', lat: 51, lng: 9, finalDepth: 4 });
const UNPLOTTED = makeBorehole({ uid: 'bh_TEST_CHAT_0000000000000003', id: 'CH-3', lat: null, lng: null, onMap: false, unplottedReason: 'no_coordinates' });
const QUESTION = makeClarification({ id: 'cl_TEST_CHAT_1', boreholeUids: [A.uid] });

let source: FakeSource;
let info: MockInstance<typeof console.info>;

beforeEach(async () => {
  source = fakeSource({ boreholes: [A, B, UNPLOTTED], documents: [makeDocument()], clarifications: [QUESTION] });
  await readyStore(source);
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  info.mockRestore();
});

/** A result set the fake server stored (every borehole deeper than 10 m: A only). */
async function storedSet(): Promise<string> {
  const rs = await source.createResultSet({ ...st().filter, minDepth: 10 });
  return rs.id;
}

const run = async (command: string, args: Record<string, unknown>) => {
  const accepted = runUiCommand({ command, args });
  await settle();
  await settle();
  return accepted;
};

describe('result sets', () => {
  it('show_result_set shows the set on the map without flying', async () => {
    const id = await storedSet();
    const outline = st().mapOutline;
    expect(await run('show_result_set', { result_set_id: id })).toBe(true);
    expect(st().resultSet?.id).toBe(id);
    expect(st().resultSet?.uids).toEqual([A.uid]);
    expect(st().resultSetId).toBe(id);
    expect(st().mapOutline).toBe(outline);
  });

  it('fit_result_set shows the set and flies to its bbox (no outline)', async () => {
    const id = await storedSet();
    expect(await run('fit_result_set', { result_set_id: id })).toBe(true);
    expect(st().resultSet?.id).toBe(id);
    expect(st().mapOutline).toMatchObject({ bbox: [8, 50, 8, 50], outline: false });
  });

  it('show_result_set then fit_result_set in one turn ends with the flight', async () => {
    const id = await storedSet();
    runUiCommand({ command: 'show_result_set', args: { result_set_id: id } });
    runUiCommand({ command: 'fit_result_set', args: { result_set_id: id } });
    await settle();
    await settle();
    await settle();
    expect(st().resultSet?.id).toBe(id);
    expect(st().mapOutline).toMatchObject({ bbox: [8, 50, 8, 50], outline: false });
  });

  it('a set the server does not have shows its error, not a set', async () => {
    expect(await run('show_result_set', { result_set_id: 'rs_TEST_MISSING' })).toBe(true);
    expect(st().resultSet).toBeNull();
    expect(st().resultSetError).toContain('not found');
  });
});

describe('fit_bounds', () => {
  it('flies to the bbox and outlines it when asked', async () => {
    expect(await run('fit_bounds', { bbox: [7.5, 49.5, 8.5, 50.5], outline: true })).toBe(true);
    expect(st().mapOutline).toMatchObject({ bbox: [7.5, 49.5, 8.5, 50.5], outline: true });
    expect(st().screen).toBe('map');
  });

  it('without outline it only flies; from another screen it goes to the map', async () => {
    st().go('queue');
    await run('fit_bounds', { bbox: [7.5, 49.5, 8.5, 50.5] });
    expect(st().mapOutline).toMatchObject({ outline: false });
    expect(st().screen).toBe('map');
  });

  it('ignores a bbox that is not four numbers in the world’s ranges', async () => {
    const before = st().mapOutline;
    expect(await run('fit_bounds', { bbox: [7.5, 49.5, 8.5] })).toBe(false);
    expect(await run('fit_bounds', { bbox: [7.5, 95, 8.5, 96] })).toBe(false);
    expect(await run('fit_bounds', { bbox: ['7', 49, 8, 50] })).toBe(false);
    expect(st().mapOutline).toBe(before);
    expect(info).toHaveBeenCalledTimes(3);
  });
});

describe('boreholes and sources', () => {
  it('focus_borehole selects the pin on the map (its popup opens)', async () => {
    st().go('queue');
    await run('focus_borehole', { uid: A.uid });
    expect(st().screen).toBe('map');
    expect(st().selectedUid).toBe(A.uid);
  });

  it('focus_borehole of a borehole without a pin opens its Detail screen', async () => {
    await run('focus_borehole', { uid: UNPLOTTED.uid });
    expect(st().screen).toBe('detail');
    expect(st().selectedUid).toBe(UNPLOTTED.uid);
  });

  it('open_detail opens Detail at the layer', async () => {
    await run('open_detail', { uid: A.uid, layer: 2 });
    expect(st().screen).toBe('detail');
    expect(st().selectedUid).toBe(A.uid);
    expect(st().selectedLayer).toBe(2);
  });

  it('open_detail without a layer (or a bad one) opens Detail at its first layer', async () => {
    await run('open_detail', { uid: A.uid, layer: -3 });
    expect(st().screen).toBe('detail');
    expect(st().selectedLayer).toBe(1);
  });

  it('open_evidence opens the Source panel at the page and box', async () => {
    await run('open_evidence', { document_id: DOC, page: 3, box: [0.1, 0.2, 0.3, 0.04] });
    expect(st().panel).toEqual({ kind: 'source', documentId: DOC, page: 3, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 } });
  });

  it('open_evidence without a box opens the page', async () => {
    await run('open_evidence', { document_id: DOC, page: 2 });
    expect(st().panel).toMatchObject({ kind: 'source', documentId: DOC, page: 2, box: null, pageOnly: true });
  });

  it('open_evidence with uid and path opens that value’s source', async () => {
    await run('open_evidence', { document_id: DOC, page: 1, uid: A.uid, path: 'metadata.borehole_depth_m' });
    expect(st().panel).toMatchObject({ kind: 'source', uid: A.uid, key: K.finalDepth, documentId: DOC, page: 1 });
  });

  it('open_review opens Review focused on the value the path names', async () => {
    await run('open_review', { uid: A.uid, path: 'stratigraphy[1].depth_to_m' });
    expect(st().screen).toBe('review');
    expect(st().reviewUid).toBe(A.uid);
    expect(st().focusKey).toBe(K.bottom(2));
  });

  it('open_review with a path that names no value opens Review on the borehole', async () => {
    await run('open_review', { uid: A.uid, path: 'metadata.nothing_like_this' });
    expect(st().screen).toBe('review');
    expect(st().reviewUid).toBe(A.uid);
  });
});

describe('filters, questions, areas, exports', () => {
  it('set_filters fills the filter panel with the filters (no area: coordinates are not trusted) and runs them', async () => {
    await run('set_filters', {
      filters: { min_depth_m: 10, include_unreviewed: true, area: { type: 'bbox', bbox: [0, 0, 1, 1] } },
    });
    await settle();
    expect(st().filter.minDepth).toBe(10);
    expect(st().filter.includeUnreviewed).toBe(true);
    expect(st().filter.area).toBeNull();
    expect(st().resultSet?.uids).toEqual([A.uid]);
  });

  it('open_clarification opens the question dialog (the list is loaded when needed)', async () => {
    expect(st().clarifications).toEqual([]);
    await run('open_clarification', { clarification_id: QUESTION.id });
    expect(st().activeClarificationId).toBe(QUESTION.id);
  });

  it('open_clarification of a question that is not open says so', async () => {
    await run('open_clarification', { clarification_id: 'cl_TEST_GONE' });
    expect(st().activeClarificationId).toBeNull();
    expect(st().toast?.text).toBe('This question is no longer open.');
  });

  it('request_area puts the map into draw mode with the prompt; the next shape becomes the chat’s area', async () => {
    st().go('queue');
    await run('request_area', { prompt: '  Draw the area you mean.  ' });
    expect(st().screen).toBe('map');
    expect(st().chatAreaRequest).toEqual({ prompt: 'Draw the area you mean.' });
    st().setChatArea({ type: 'bbox', bbox: [8, 50, 9, 51] });
    expect(st().chatAreaRequest).toBeNull();
    expect(st().chatArea).toEqual({ type: 'bbox', bbox: [8, 50, 9, 51] });
  });

  it('export_document opens the export menu of the report preset; nothing is downloaded', async () => {
    const exportFile = vi.spyOn(st(), 'exportFile');
    await run('export_document', { document_id: DOC, format: 'xlsx', include_unreviewed: true });
    expect(st().screen).toBe('detail');
    expect([A.uid, B.uid, UNPLOTTED.uid]).toContain(st().selectedUid);
    expect(st().exportOpen).toBe(true);
    expect(st().includeUnreviewed).toBe(true);
    expect(exportFile).not.toHaveBeenCalled();
  });

  it('export_document without include_unreviewed presets approved values only', async () => {
    if (!st().includeUnreviewed) st().toggleIncludeUnreviewed();
    await run('export_document', { document_id: DOC, format: 'csv', include_unreviewed: false });
    expect(st().exportOpen).toBe(true);
    expect(st().includeUnreviewed).toBe(false);
  });
});

describe('what is not run', () => {
  it('ignores an unknown command with one console.info', async () => {
    const before = { screen: st().screen, panel: st().panel, mapOutline: st().mapOutline };
    expect(await run('delete_everything', { uid: A.uid })).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('delete_everything');
    expect({ screen: st().screen, panel: st().panel, mapOutline: st().mapOutline }).toEqual(before);
  });

  it('ignores data that is not a command, and commands without their ids', async () => {
    expect(runUiCommand(null)).toBe(false);
    expect(runUiCommand('fit_bounds')).toBe(false);
    expect(runUiCommand({ command: 'focus_borehole', args: {} })).toBe(false);
    expect(runUiCommand({ command: 'show_result_set', args: { result_set_id: 42 } })).toBe(false);
    expect(runUiCommand({ command: 'request_area', args: { prompt: '   ' } })).toBe(false);
    expect(info).toHaveBeenCalledTimes(5);
  });

  it('never takes coordinates from focus_borehole (the pin comes from the store)', async () => {
    await run('focus_borehole', { uid: A.uid, lat: 0, lng: 0, bbox: [0, 0, 1, 1] });
    expect(st().selectedUid).toBe(A.uid);
    expect(st().mapOutline).toBeNull();
  });
});

describe('data-clarification', () => {
  it('a question the chat sent joins the list and its dialog opens (contract example)', () => {
    const wire = EXAMPLES['Clarification.chat_parameter.json'] as { clarification_id: string };
    expect(openChatClarification(wire)).toBe(true);
    expect(st().clarifications.some((c) => c.id === wire.clarification_id)).toBe(true);
    expect(st().activeClarificationId).toBe(wire.clarification_id);
    // Twice (the card's ANSWER again): still one entry.
    expect(openChatClarification(wire)).toBe(true);
    expect(st().clarifications.filter((c) => c.id === wire.clarification_id)).toHaveLength(1);
  });

  it('data that is not a question opens nothing', () => {
    expect(openChatClarification({ question: 'no id' })).toBe(false);
    expect(st().activeClarificationId).toBeNull();
  });
});
