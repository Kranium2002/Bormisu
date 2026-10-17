/** F12: every form widget, server-rendered (fictional questions; Leaflet maps are not drawn here). */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormField, PageContent } from '../../domain/types';
import { DOC, makeCandidate, makeEvidence, makeField } from './clarifyFixtures';
import { initialInput, type FieldInput } from './clarifyModel';
import { FieldWidget, type WidgetContext } from './FieldWidget';
import { resetTestStore, testStore } from './testStore';

vi.mock('leaflet', () => ({}));
vi.mock('../../store/appStore', async (importOriginal) => (await import('./testStore')).mockAppStore(await importOriginal()));

const CTX: WidgetContext = {
  pageCount: 12,
  crs: { status: 'ready', candidates: [], error: null },
  swapAxes: null,
  reference: [],
  labels: {},
};

const render = (field: FormField, input: FieldInput = initialInput(field), error: string | null = null, ctx: Partial<WidgetContext> = {}) =>
  renderToStaticMarkup(<FieldWidget field={field} input={input} onChange={() => undefined} error={error} idBase="f0" ctx={{ ...CTX, ...ctx }} />);

/** The opening tag of the first element matching `re`. */
const tag = (html: string, re: RegExp) => html.match(re)?.[0] ?? '';

const page = (n: number): PageContent => ({ documentId: DOC, page: n, type: 'log', usage: 'used', label: `page ${n} · fictional.pdf`, items: [] });

beforeEach(() => resetTestStore());

describe('FieldWidget', () => {
  it('text: a labelled input with the server default; required is marked', () => {
    const html = render(makeField({ name: 'note', widget: 'text', label: 'Where does it come from?', required: true, default: 'site plan' }));
    expect(html).toContain('<label for="f0"');
    expect(html).toContain('Where does it come from?');
    expect(html).toMatch(/<span[^>]*aria-hidden="true"> \*<\/span>/);
    expect(tag(html, /<input[^>]*id="f0"[^>]*>/)).toContain('value="site plan"');
    expect(tag(html, /<input[^>]*id="f0"[^>]*>/)).toContain('required=""');
  });

  it('number_unit: the number and a unit select from the server’s units, none chosen for the reviewer', () => {
    const html = render(makeField({ name: 'value', widget: 'number_unit', label: 'Unit weight', required: true, unitOptions: ['kN/m3', 't/m3'], default: 19.6 }));
    expect(tag(html, /<input[^>]*id="f0"[^>]*>/)).toContain('value="19.6"');
    expect(tag(html, /<input[^>]*id="f0"[^>]*>/)).toContain('inputMode="decimal"');
    expect(html).toContain('aria-label="Unit weight: unit"');
    expect(html).toMatch(/<option value="" selected="">Unit…<\/option><option value="kN\/m3">kN\/m3<\/option><option value="t\/m3">t\/m3<\/option>/);
    // A chosen unit shows as selected.
    const chosen = render(makeField({ name: 'value', widget: 'number_unit', unitOptions: ['kN/m3', 't/m3'] }), { kind: 'number_unit', number: '2', unit: 't/m3' });
    expect(chosen).toContain('<option value="t/m3" selected="">t/m3</option>');
    // Without units from the server there is no unit select.
    expect(render(makeField({ name: 'v', widget: 'number_unit' }))).not.toContain('<select');
  });

  it('select: the server’s options by their labels, "Choose…" until one is picked', () => {
    const f = makeField({
      name: 'origin', widget: 'select', label: 'Depths are measured from', required: true,
      options: [{ value: 'ground', label: 'Ground level', evidence: null }, { value: 'relative', label: 'A deck (relative)', evidence: null }],
    });
    const html = render(f);
    expect(html).toMatch(/<option value="" selected="">Choose…<\/option><option value="0">Ground level<\/option><option value="1">A deck \(relative\)<\/option>/);
    expect(render(f, { kind: 'choice', index: 1, none: false })).toContain('<option value="1" selected="">A deck (relative)</option>');
  });

  it('boolean: two radios, neither checked without a default; the default checks one', () => {
    const f = makeField({ name: 'same', widget: 'boolean', label: 'Both pages show the same log', required: true });
    const none = render(f);
    expect(none).toContain('<legend');
    expect(none.match(/type="radio"/g)).toHaveLength(2);
    expect(none).not.toContain('checked=""');
    const yes = render({ ...f, default: true });
    expect(tag(yes, /<input[^>]*checked=""[^>]*>/)).toBeTruthy();
    expect(yes).toMatch(/checked=""[^>]*\/>Yes<\/label>/);
  });

  it('map_point: a map to click plus latitude and longitude inputs (the keyboard path)', () => {
    const html = render(makeField({ name: 'location', widget: 'map_point', label: 'Click the borehole position on the map', required: true, help: 'The plan on page 4 shows it.' }), {
      kind: 'point', lat: '-41.28', lon: '174.77',
    });
    expect(html).toContain('aria-label="Click the borehole position on the map: click the map to place the point"');
    expect(html).toMatch(/Latitude \(WGS84\)<input[^>]*value="-41.28"/);
    expect(html).toMatch(/Longitude \(WGS84\)<input[^>]*value="174.77"/);
    expect(html).toContain('<p id="f0-help"');
    expect(tag(html, /<input[^>]*id="f0"[^>]*>/)).toContain('aria-describedby="f0-help"');
  });

  it('choose_reading: one card per reading with its evidence crop; "None of these" only when optional', () => {
    testStore.pages[`${DOC}:6`] = { status: 'ready', content: page(6) };
    const f = makeField({
      name: 'reading', widget: 'choose_reading', label: 'Layer bottom (m)', required: true,
      options: [
        { value: 9.5, label: '9,50 (OCR, confidence 0.58)', evidence: makeEvidence({ page: 6, box: { x: 0.08, y: 0.41, w: 0.06, h: 0.02 }, snippet: '9,50' }) },
        { value: 9.8, label: '9,80 (second read, confidence 0.71)', evidence: makeEvidence({ page: 7, box: { x: 0.1, y: 0.4, w: 0.05, h: 0.02 }, snippet: '9,80' }) },
      ],
    });
    const html = render(f, { kind: 'choice', index: 1, none: false });
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain('9,50 (OCR, confidence 0.58)');
    expect(html).toContain('role="img" aria-label="Page 6: “9,50”"');
    // Page 7 is not in the cache yet.
    expect(html).toContain('Loading page 7…');
    expect(html).toMatch(/checked=""[^>]*\/>.*9,80 \(second read/);
    expect(html).not.toContain('None of these');
    expect(render({ ...f, required: false })).toContain('None of these');
  });

  it('page_range: from / to page inputs within the document', () => {
    const html = render(makeField({ name: 'pages', widget: 'page_range', label: 'Pages of KB-1', required: true, default: [3, 4] }));
    expect(html).toMatch(/From page<input[^>]*min="1"[^>]*max="12"[^>]*value="3"/);
    expect(html).toMatch(/To page<input[^>]*value="4"/);
    expect(html).toContain('of 12 pages');
    expect(render(makeField({ name: 'pages', widget: 'page_range' }), undefined, null, { pageCount: null })).not.toContain('max=');
  });

  it('crs_picker: options with the matched candidate’s verdict, note, score, swap mark and a mini-map; unmatched without a preview', () => {
    const f = makeField({
      name: 'crs', widget: 'crs_picker', label: 'Coordinate system', required: true,
      options: [
        { value: 'EPSG:0001', label: 'Fictional Grid A', evidence: null },
        { value: 'EPSG:0002', label: 'Fictional Grid B', evidence: null },
        { value: 'EPSG:0003', label: 'Fictional Grid C', evidence: null },
      ],
    });
    const candidates = [
      makeCandidate({ code: 'EPSG:0001', verdict: 'match', score: 1, note: 'centroid inside the fictional place' }),
      makeCandidate({ code: 'EPSG:0002', verdict: 'shifted', score: 0.37, swapAxes: true, note: '8611 km away' }),
    ];
    const html = render(f, { kind: 'choice', index: 0, none: false }, null, { crs: { status: 'ready', candidates, error: null } });
    const radios = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(radios[0]).toContain('aria-checked="true"');
    expect(radios[0]).toContain('border-left-color:#1E7B34');
    expect(radios[1]).toContain('border-left-color:#E39B00');
    // No candidate: the neutral colour.
    expect(radios[2]).toContain('border-left-color:#A3A3A2');
    expect(html).toContain('EPSG:0001 · score 1.00');
    expect(html).toContain('pins on site · centroid inside the fictional place');
    expect(html).toContain('shifted from the site · 8611 km away');
    expect(html).toContain('⇄ X / Y swapped');
    expect(html).toContain('No preview: the server lists no positions for this system');
    // Two thumbnails beside the matched options, plus the picked one large.
    expect(html.match(/<div class="[^"]*previewMap[^"]*" aria-hidden="true"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Map preview of Fictional system EPSG:0001: 1 borehole placed"');
  });

  it('crs_picker while the candidates load, and when they fail', () => {
    const f = makeField({ name: 'crs', widget: 'crs_picker', options: [{ value: 'EPSG:0001', label: 'Fictional Grid A', evidence: null }] });
    expect(render(f, undefined, null, { crs: { status: 'loading', candidates: [], error: null } })).toContain('Loading where it places the boreholes…');
    expect(render(f, undefined, null, { crs: { status: 'error', candidates: [], error: 'Backend unreachable' } })).toContain('Positions could not be loaded: Backend unreachable');
  });

  it('an error shows next to the field and marks its control', () => {
    const html = render(makeField({ name: 'value', widget: 'number_unit', label: 'Unit weight', required: true, unitOptions: ['kN/m3'] }), undefined, 'Enter a number.');
    expect(html).toContain('<p id="f0-error"');
    expect(html).toContain('Enter a number.');
    const input = tag(html, /<input[^>]*id="f0"[^>]*>/);
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="f0-error"');
  });
});
