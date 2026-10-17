/** The sheet's original-page pane (fictional borehole): which page and box it shows for a value, its notes and the remembered layout. */
import { describe, expect, it, vi } from 'vitest';
import type { Method } from '../../domain/types';
import { makeBorehole, makeValue } from '../../test/fixtures';
import {
  canOpenOther,
  clampWidth,
  firstPage,
  PANE_KEY,
  PANE_MIN,
  PANE_SHARE,
  paneBoxes,
  paneMax,
  paneNote,
  paneTarget,
  paneView,
  paneWidth,
  readPaneLayout,
  shareOf,
  valueStop,
  writePaneLayout,
  type PaneView,
} from './sourcePaneModel';

const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.04 };
const box2 = { x: 0.5, y: 0.6, w: 0.2, h: 0.03 };
const OTHER = 'doc_FICTIONAL_LAB_0000000000001';
const t = (en: string) => en;
/** The borehole's own document (makeBorehole) at page `page`. */
const own = (page: number | null): PaneView => ({ documentId: 'doc_TEST0000000000000000000001', page, other: false });

function borehole() {
  return makeBorehole({
    pages: [4],
    values: [
      makeValue({ key: 'id', label: 'Borehole ID', raw: 'TB 1', value: 'TB-01', page: 3, box }),
      makeValue({ key: 'depth', label: 'Final depth', raw: '6,00 m', value: '6.00', page: 3, box: box2 }),
      makeValue({ key: 'method', label: 'Drilling method', raw: 'Rotary', value: 'Rotary', page: 4, box: null }),
      makeValue({
        key: 'lith', label: 'Lithology', raw: 'Sand', value: 'Sand', page: 3, box,
        sources: [{ page: 3, box }, { page: 5, box: box2 }, { page: 6, box: null }],
      }),
      makeValue({ key: 'ucs', label: 'UCS', value: '12.5', page: 2, box, documentId: OTHER }),
      makeValue({ key: 'lab', label: 'Su', value: '40', page: null, box: null, cell: 'Lab!D7', documentId: OTHER }),
      makeValue({ key: 'cellOwn', label: 'Water content', value: '21', page: null, box: null, cell: 'Logdata!C5' }),
      makeValue({ key: 'guess', label: 'Country', value: 'Fictionland', page: null, box: null, method: 'Guessed' }),
      makeValue({ key: 'derived', label: 'Rock head', value: '4.20', page: null, box: null, method: 'Derived' }),
      makeValue({ key: 'nopage', label: 'Notes', value: 'dry', page: null, box: null }),
      makeValue({ key: 'whole', label: 'Log language', value: 'de', page: 4, box, method: 'page' as Method }),
    ],
  });
}

describe('first page and the page shown', () => {
  it('opens on the borehole’s first page with values or read from', () => {
    expect(firstPage(borehole())).toBe(3);
    expect(firstPage(makeBorehole({ pages: [], values: [] }))).toBeNull();
  });

  it('shows the active value’s page, else the page picked in the strip, else the first page', () => {
    const b = borehole();
    expect(paneView(b, paneTarget(b, 'method'), 7, false)).toEqual(own(4));
    expect(paneView(b, paneTarget(b, 'ucs'), 7, false)).toEqual(own(7));
    expect(paneView(b, null, null, false)).toEqual(own(3));
    expect(paneView(makeBorehole({ pages: [], values: [] }), null, null, false).page).toBeNull();
  });

  it('shows another document’s page only once it is opened for a value from there', () => {
    const b = borehole();
    expect(paneView(b, paneTarget(b, 'ucs'), null, true)).toEqual({ documentId: OTHER, page: 2, other: true });
    // A cell has no page to open; a value of the own document ignores the flag.
    expect(paneView(b, paneTarget(b, 'lab'), null, true)).toEqual(own(3));
    expect(paneView(b, paneTarget(b, 'id'), null, true)).toEqual(own(3));
  });
});

describe('paneTarget', () => {
  const b = borehole();

  it('a value on a page of the borehole’s document: that page and its box', () => {
    expect(paneTarget(b, 'id')).toEqual({ kind: 'page', page: 3, box, index: 0, count: 1 });
    expect(paneNote(paneTarget(b, 'id'), t)).toBeNull();
  });

  it('a value without a box: its page, saying there is no box on it', () => {
    expect(paneTarget(b, 'method')).toEqual({ kind: 'page', page: 4, box: null, index: 0, count: 1 });
    expect(paneNote(paneTarget(b, 'method'), t)).toBe('No box on this page');
    // Backed by the whole page: no box drawn either.
    expect(paneTarget(b, 'whole')).toMatchObject({ page: 4, box: null });
  });

  it('a value cited on several pages: source i of N with its page and box there, clamped to its sources', () => {
    expect(paneTarget(b, 'lith', 0)).toEqual({ kind: 'page', page: 3, box, index: 0, count: 3 });
    expect(paneTarget(b, 'lith', 1)).toEqual({ kind: 'page', page: 5, box: box2, index: 1, count: 3 });
    expect(paneTarget(b, 'lith', 2)).toEqual({ kind: 'page', page: 6, box: null, index: 2, count: 3 });
    expect(paneTarget(b, 'lith', 9)).toMatchObject({ page: 6, index: 2 });
    expect(paneTarget(b, 'lith', -1)).toMatchObject({ page: 3, index: 0 });
    expect(valueStop(b.values.find((v) => v.key === 'lith')!, 1)).toEqual({ page: 5, box: box2 });
    expect(valueStop(b.values.find((v) => v.key === 'id')!, 1)).toEqual({ page: 3, box });
  });

  it('a value from another document: says so (with the file when known) and offers its page', () => {
    expect(paneTarget(b, 'ucs')).toEqual({ kind: 'otherDocument', documentId: OTHER, page: 2, box, cell: null });
    expect(paneNote(paneTarget(b, 'ucs'), t, { docName: 'fictional-lab.pdf' })).toBe('This value is from another document: fictional-lab.pdf · page 2');
    expect(paneNote(paneTarget(b, 'lab'), t)).toBe('This value is from another document · cell Lab!D7');
    expect(canOpenOther(paneTarget(b, 'ucs'), false)).toBe(true);
    // Its page is open: no note (the label names the file), no button; a cell has no page to open.
    expect(paneNote(paneTarget(b, 'ucs'), t, { otherShown: true })).toBeNull();
    expect(canOpenOther(paneTarget(b, 'ucs'), true)).toBe(false);
    expect(canOpenOther(paneTarget(b, 'lab'), false)).toBe(false);
    expect(canOpenOther(paneTarget(b, 'id'), false)).toBe(false);
  });

  it('a spreadsheet value of the own document names its cell', () => {
    expect(paneTarget(b, 'cellOwn')).toEqual({ kind: 'cell', cell: 'Logdata!C5' });
    expect(paneNote(paneTarget(b, 'cellOwn'), t)).toBe('Spreadsheet value: cell Logdata!C5, no page image');
  });

  it('a value on no page says why', () => {
    expect(paneTarget(b, 'guess')).toEqual({ kind: 'noPage', method: 'Guessed' });
    expect(paneNote(paneTarget(b, 'guess'), t)).toBe('Not printed on a page: this value was guessed.');
    expect(paneNote(paneTarget(b, 'derived'), t)).toBe('Not printed on a page: this value was derived.');
    expect(paneNote(paneTarget(b, 'nopage'), t)).toBe('No page reference for this value.');
  });

  it('no value, or one the borehole does not have: nothing to show', () => {
    expect(paneTarget(b, null)).toBeNull();
    expect(paneTarget(b, 'missing')).toBeNull();
    expect(paneNote(null, t)).toBeNull();
  });

  it('notes come in the UI language', () => {
    const de = (en: string) => ({ 'No box on this page': 'Ohne Markierung auf dieser Seite' })[en] ?? en;
    expect(paneNote(paneTarget(b, 'method'), de)).toBe('Ohne Markierung auf dieser Seite');
  });
});

describe('paneBoxes', () => {
  const b = borehole();

  it('draws the other boxed values of the page idle and the active value highlighted, last', () => {
    const boxes = paneBoxes(b, own(3), 'depth', paneTarget(b, 'depth'));
    expect(boxes.map((x) => [x.key, x.variant])).toEqual([
      ['id', 'idle'],
      ['lith', 'idle'],
      ['depth', 'highlight'],
    ]);
    expect(boxes[2]).toMatchObject({ box: box2, label: 'Final depth', raw: '6,00 m' });
  });

  it('highlights a value cited on several pages at its box on the source shown', () => {
    const boxes = paneBoxes(b, own(5), 'lith', paneTarget(b, 'lith', 1));
    expect(boxes).toEqual([{ key: 'lith', box: box2, variant: 'highlight', label: 'Lithology', raw: 'Sand' }]);
    // On another page than the source shown, it is not drawn.
    expect(paneBoxes(b, own(3), 'lith', paneTarget(b, 'lith', 1)).map((x) => x.key)).toEqual(['id', 'depth']);
  });

  it('without an active value every box is idle; no page, no boxes', () => {
    expect(paneBoxes(b, own(3), null, null).every((x) => x.variant === 'idle')).toBe(true);
    expect(paneBoxes(b, own(null), 'id', paneTarget(b, 'id'))).toEqual([]);
    // A value from another document leaves the page's own boxes idle.
    expect(paneBoxes(b, own(3), 'ucs', paneTarget(b, 'ucs')).map((x) => x.variant)).toEqual(['idle', 'idle', 'idle']);
  });

  it('on another document’s opened page only the value’s own box, highlighted', () => {
    const view = paneView(b, paneTarget(b, 'ucs'), null, true);
    expect(paneBoxes(b, view, 'ucs', paneTarget(b, 'ucs'))).toEqual([{ key: 'ucs', box, variant: 'highlight', label: 'UCS', raw: '' }]);
  });
});

describe('remembered width and collapsed state', () => {
  const storage = (value: string | null) => ({ getItem: vi.fn(() => value) });

  it('defaults to half the row, open on a wide screen and hidden on a narrow one', () => {
    expect(readPaneLayout(false, storage(null))).toEqual({ share: PANE_SHARE, collapsed: false });
    expect(readPaneLayout(true, storage(null))).toEqual({ share: PANE_SHARE, collapsed: true });
    expect(readPaneLayout(false, null)).toEqual({ share: PANE_SHARE, collapsed: false });
  });

  it('reads what was stored, clamped; ignores what is not valid; a narrow screen always starts hidden', () => {
    expect(readPaneLayout(false, storage('{"share":0.4,"collapsed":true}'))).toEqual({ share: 0.4, collapsed: true });
    expect(readPaneLayout(true, storage('{"share":0.4,"collapsed":false}'))).toEqual({ share: 0.4, collapsed: true });
    expect(readPaneLayout(false, storage('{"share":5,"collapsed":false}'))).toEqual({ share: 0.9, collapsed: false });
    expect(readPaneLayout(false, storage('{"share":"wide","collapsed":"yes"}'))).toEqual({ share: PANE_SHARE, collapsed: false });
    expect(readPaneLayout(false, storage('not json'))).toEqual({ share: PANE_SHARE, collapsed: false });
    const blocked = { getItem: () => { throw new Error('blocked'); } };
    expect(readPaneLayout(true, blocked)).toEqual({ share: PANE_SHARE, collapsed: true });
  });

  it('writes the layout as JSON, keeps the wide screen’s collapsed state from a narrow one, and survives blocked storage', () => {
    const setItem = vi.fn();
    writePaneLayout({ share: 0.4, collapsed: true }, false, { getItem: () => null, setItem });
    expect(setItem).toHaveBeenLastCalledWith(PANE_KEY, '{"share":0.4,"collapsed":true}');
    writePaneLayout({ share: 0.4, collapsed: true }, true, { getItem: () => '{"share":0.5,"collapsed":false}', setItem });
    expect(setItem).toHaveBeenLastCalledWith(PANE_KEY, '{"share":0.4,"collapsed":false}');
    const full = { getItem: () => null, setItem: () => { throw new Error('full'); } };
    expect(() => writePaneLayout({ share: 0.4, collapsed: true }, false, full)).not.toThrow();
  });

  it('turns the share into a width within the limits, leaving the sheet room, and back', () => {
    expect(paneWidth(PANE_SHARE, 1432)).toBe(716);
    expect(paneWidth(0.1, 1432)).toBe(PANE_MIN);
    expect(paneWidth(0.9, 1000)).toBe(680);
    expect(clampWidth(480.4, 1432)).toBe(480);
    expect(clampWidth(Number.NaN, 1000)).toBe(500);
    expect(paneMax(500)).toBe(PANE_MIN);
    expect(paneMax(1432)).toBe(1112);
    expect(shareOf(740, 1480)).toBe(0.5);
    expect(shareOf(740, 0)).toBe(PANE_SHARE);
  });
});
