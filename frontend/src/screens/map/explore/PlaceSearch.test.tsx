/** F11 place search, server-rendered (fictional places): the form, busy, errors, one and several candidates, and empty places. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlaceCandidate } from '../../../domain/types';
import { NO_PLACE_FOUND, PLACE_SEARCH_UNAVAILABLE } from '../../../store/mapDataSlice';
import { chosenAfterSearch, noUploadedBoreholes, placeCountText, placeKindText, placeStatusText } from './placeModel';
import { PlaceSearchView, type PlaceSearchViewProps } from './PlaceSearch';

const place = (o: Partial<PlaceCandidate> = {}): PlaceCandidate => ({
  label: 'Fictional Town', lat: 50, lng: 8, bbox: [7.9, 49.9, 8.2, 50.2], source: 'geocoder', kind: 'city', boreholeCount: null, ...o,
});
const PIN_INSIDE = { lat: 50, lng: 8 };

function render(o: Partial<PlaceSearchViewProps> = {}): string {
  const props: PlaceSearchViewProps = {
    text: '', onTextChange: () => undefined, onSubmit: () => undefined, onChoose: () => undefined,
    busy: false, error: null, places: null, chosen: null, empty: [], hint: null, ...o,
  };
  return renderToStaticMarkup(<PlaceSearchView {...props} />);
}

describe('place model', () => {
  it('a place holds no uploaded borehole when the server counts none (or does not know) and no pin lies in its box', () => {
    expect(noUploadedBoreholes(place({ boreholeCount: 0 }), [])).toBe(true);
    expect(noUploadedBoreholes(place({ boreholeCount: null }), [])).toBe(true);
    expect(noUploadedBoreholes(place({ boreholeCount: 0 }), [PIN_INSIDE])).toBe(false);
    expect(noUploadedBoreholes(place({ boreholeCount: 3 }), [])).toBe(false);
    // A point without a box: only the server's 0 says so; unknown stays unknown.
    expect(noUploadedBoreholes(place({ bbox: null, boreholeCount: 0 }), [])).toBe(true);
    expect(noUploadedBoreholes(place({ bbox: null, boreholeCount: null }), [])).toBe(false);
  });

  it('texts: kind in words, the count when known, the status line', () => {
    expect(placeKindText('project_site')).toBe('project site');
    expect(placeKindText(null)).toBe('');
    expect(placeCountText(place({ boreholeCount: 1 }))).toBe('1 borehole');
    expect(placeCountText(place({ boreholeCount: 12 }))).toBe('12 boreholes');
    expect(placeCountText(place({ boreholeCount: null }))).toBeNull();
    expect(placeStatusText({ busy: true, error: null, places: null })).toBe('Searching…');
    expect(placeStatusText({ busy: false, error: NO_PLACE_FOUND, places: [] })).toBe(NO_PLACE_FOUND);
    expect(placeStatusText({ busy: false, error: null, places: [place()] })).toBe('1 place found');
    expect(placeStatusText({ busy: false, error: null, places: [place(), place()] })).toBe('2 places found');
    expect(placeStatusText({ busy: false, error: null, places: null })).toBe('');
  });

  it('one candidate is the chosen one (the store flies there); several wait for a choice', () => {
    expect(chosenAfterSearch([place()])).toBe(0);
    expect(chosenAfterSearch([place(), place()])).toBeNull();
    expect(chosenAfterSearch([])).toBeNull();
    expect(chosenAfterSearch(null)).toBeNull();
  });
});

describe('PlaceSearchView', () => {
  it('a search form: a labelled field and a SEARCH submit button, no typeahead list', () => {
    const html = render({ text: 'Fictional' });
    expect(html).toMatch(/<form[^>]*role="search"[^>]*aria-label="Place search"/);
    expect(html).toMatch(/<label[^>]*for="place-query"[^>]*>Town, address or place<\/label>/);
    expect(html).toMatch(/<input[^>]*id="place-query"[^>]*value="Fictional"/);
    expect(html).not.toContain('list=');
    expect(html).toMatch(/<button type="submit"[^>]*>SEARCH<\/button>/);
    // The status line is always there, so what it says is announced.
    expect(html).toMatch(/<p[^>]*role="status"[^>]*><\/p>/);
  });

  it('busy: aria-busy, the button is off and the status says so', () => {
    const html = render({ busy: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>SEARCH<\/button>/);
    expect(html).toMatch(/role="status"[^>]*>Searching…<\/p>/);
  });

  it('errors are in the status line', () => {
    expect(render({ error: NO_PLACE_FOUND, places: [] })).toMatch(/role="status"[^>]*>No place found<\/p>/);
    expect(render({ error: PLACE_SEARCH_UNAVAILABLE })).toMatch(/role="status"[^>]*>Place search unavailable<\/p>/);
  });

  it('several candidates in the server’s order, each a button with label, kind, source and count', () => {
    const places = [
      place({ label: 'Site Office (uploaded, fictional)', source: 'uploaded', kind: 'project_site', boreholeCount: 3 }),
      place({ label: 'Fictional Town', source: 'geocoder', kind: 'city', boreholeCount: null }),
    ];
    const html = render({ places, empty: [false, true] });
    const buttons = html.match(/<button type="button"[^>]*data-place="\d"[^>]*>.*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('Site Office (uploaded, fictional)');
    expect(buttons[0]).toContain('project site');
    expect(buttons[0]).toMatch(/>uploaded<\/span>/);
    expect(buttons[0]).toContain('3 boreholes');
    expect(buttons[1]).toMatch(/>geocoder<\/span>/);
    expect(buttons[1]).not.toContain('borehole');
    // Not chosen yet: no "none here" note.
    expect(html).not.toContain('No uploaded boreholes here');
    expect(html).toMatch(/role="status"[^>]*>2 places found<\/p>/);
  });

  it('the chosen place is marked; one without uploaded boreholes says so next to it', () => {
    const places = [place({ label: 'Site Office', source: 'uploaded', boreholeCount: 3 }), place({ label: 'Empty Town', boreholeCount: 0 })];
    const html = render({ places, chosen: 1, empty: [false, true] });
    expect(html).toMatch(/<button type="button"[^>]*aria-pressed="false"[^>]*data-place="0"/);
    expect(html).toMatch(/<button type="button"[^>]*aria-pressed="true"[^>]*aria-describedby="place-none-1"[^>]*data-place="1"/);
    expect(html).toMatch(/<p id="place-none-1"[^>]*>No uploaded boreholes here<\/p>/);
  });

  it('a hint when the server has no geocoder', () => {
    expect(render({ hint: 'Only places named in uploaded reports are found: the server has no geocoder.' })).toContain(
      'Only places named in uploaded reports are found: the server has no geocoder.',
    );
  });
});
