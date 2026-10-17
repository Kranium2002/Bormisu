/** F10 filter panel, server-rendered (fictional values): fields from the filter, validation, tri-states, the DIN multi-select, busy. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BoreholeFilter } from '../../../domain/types';
import { emptyFilter } from '../../../store/mapDataSlice';
import { FilterPanelView, type FilterPanelViewProps } from './FilterPanel';
import { RANGE_INVALID } from './filterModel';

const noop = () => undefined;

function render(filter: Partial<BoreholeFilter> = {}, o: Partial<FilterPanelViewProps> = {}): string {
  const props: FilterPanelViewProps = {
    filter: { ...emptyFilter(), ...filter },
    texts: { minDepth: '', maxDepth: '', lithologyMinDepth: '' },
    errors: {},
    dinQuery: '',
    documents: [
      { id: 'doc_TEST_A', name: 'alpha_report.pdf' },
      { id: 'doc_TEST_B', name: 'beta_report.pdf' },
    ],
    projects: ['Alpha (fictional)', 'Bravo (fictional)'],
    busy: false,
    error: null,
    onChange: noop,
    onDepthText: noop,
    onDinQuery: noop,
    onApply: noop,
    onReset: noop,
    ...o,
  };
  return renderToStaticMarkup(<FilterPanelView {...props} />);
}

/** The opening tag of the element with this id. */
const tag = (html: string, id: string) => new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';

describe('FilterPanelView', () => {
  it('only the contract’s fields: search, country, project (with the known names), document, depths, DIN codes, SPT, groundwater, review status, include unreviewed', () => {
    const html = render();
    for (const label of ['Search', 'Country', 'Project', 'Document', 'Minimum depth (m)', 'Maximum depth (m)', 'Lithology reaches below (m)', 'Include unreviewed boreholes']) {
      expect(html, label).toContain(`>${label}</label>`);
    }
    for (const legend of ['Final depth', 'DIN 4023 codes', 'Has SPT', 'Has groundwater', 'Review status']) {
      expect(html, legend).toContain(`<legend`);
      expect(html, legend).toContain(`>${legend}</legend>`);
    }
    expect(html).toMatch(/<datalist id="filter-projects"><option value="Alpha \(fictional\)"><\/option><option value="Bravo \(fictional\)"><\/option><\/datalist>/);
    expect(html).toMatch(/<option value="" selected="">Any document<\/option><option value="doc_TEST_A">alpha_report.pdf<\/option>/);
    expect(html).toMatch(/<button type="submit"[^>]*>APPLY<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>RESET<\/button>/);
  });

  it('shows the filter’s values; include unreviewed is on by default', () => {
    const html = render({ search: 'TB', project: 'Alpha (fictional)', documentId: 'doc_TEST_B', reviewStatus: ['approved'] }, { texts: { minDepth: '2.5', maxDepth: '18', lithologyMinDepth: '' } });
    expect(tag(html, 'filter-search')).toContain('value="TB"');
    expect(tag(html, 'filter-project')).toContain('value="Alpha (fictional)"');
    expect(tag(html, 'filter-project')).toContain('list="filter-projects"');
    expect(html).toContain('<option value="doc_TEST_B" selected="">beta_report.pdf</option>');
    expect(tag(html, 'filter-min-depth')).toContain('value="2.5"');
    expect(tag(html, 'filter-max-depth')).toContain('value="18"');
    expect(tag(html, 'filter-status-approved')).toContain('checked=""');
    expect(tag(html, 'filter-status-unreviewed')).not.toContain('checked');
    expect(tag(html, 'filter-include-unreviewed')).toContain('checked=""');
    expect(tag(render({ includeUnreviewed: false }), 'filter-include-unreviewed')).not.toContain('checked');
  });

  it('a depth error marks the field invalid, describes it and is announced', () => {
    const html = render({}, { texts: { minDepth: '20', maxDepth: '5', lithologyMinDepth: '' }, errors: { maxDepth: RANGE_INVALID } });
    expect(tag(html, 'filter-max-depth')).toContain('aria-invalid="true"');
    expect(tag(html, 'filter-max-depth')).toContain('aria-describedby="filter-max-depth-error"');
    expect(tag(html, 'filter-min-depth')).toContain('aria-invalid="false"');
    expect(html).toMatch(/<p id="filter-max-depth-error"[^>]*role="alert"[^>]*>The maximum depth must not be less than the minimum\.<\/p>/);
  });

  it('tri-states: any / yes / no radios, the filter’s value checked', () => {
    const html = render({ hasSpt: true, hasGroundwater: false });
    expect(tag(html, 'filter-spt-yes')).toContain('checked=""');
    expect(tag(html, 'filter-spt-any')).not.toContain('checked');
    expect(tag(html, 'filter-gw-no')).toContain('checked=""');
    const none = render();
    expect(tag(none, 'filter-spt-any')).toContain('checked=""');
    expect(tag(none, 'filter-gw-any')).toContain('checked=""');
  });

  it('DIN codes: every code with its English name as a checkbox; the chosen ones checked and listed; the lithology depth is off without codes', () => {
    const off = render();
    expect(off.match(/<input type="checkbox"[^>]*data-din="[^"]+"/g)).toHaveLength(49);
    expect(off).toMatch(/data-din="mG"[^>]*\/><code[^>]*>mG<\/code><span>Medium gravel<\/span>/);
    expect(tag(off, 'filter-lith-depth')).toContain('disabled=""');
    expect(off).toContain('Choose DIN codes first.');
    expect(off).toContain('None chosen: any lithology.');

    const on = render({ dinCodes: ['mG', 'Mg'] });
    const box = (code: string) => new RegExp(`<input type="checkbox"[^>]*data-din="${code}"[^>]*/>`).exec(on)?.[0] ?? '';
    expect(box('mG')).toContain('checked=""');
    expect(box('Mg')).toContain('checked=""');
    expect(box('G')).not.toContain('checked');
    expect(on).toContain('2 chosen: mG Medium gravel, Mg Till marl');
    expect(tag(on, 'filter-lith-depth')).not.toContain('disabled');
    expect(on).toMatch(/<button type="button"[^>]*>CLEAR CODES<\/button>/);
  });

  it('the code search narrows the list and says when nothing matches', () => {
    expect(render({}, { dinQuery: 'gravel' }).match(/data-din="/g)).toHaveLength(4);
    expect(render({}, { dinQuery: 'zzz' })).toContain('No DIN code matches “zzz”.');
  });

  it('an area drawn on the map is shown with a way to take it out', () => {
    const html = render({ area: { type: 'bbox', bbox: [7, 49, 8, 50] } });
    expect(html).toContain('Rectangle drawn on the map');
    expect(html).toMatch(/<button type="button"[^>]*>REMOVE AREA<\/button>/);
    expect(render()).not.toContain('REMOVE AREA');
  });

  it('busy: aria-busy and APPLY is off while the request runs', () => {
    const html = render({}, { busy: true });
    expect(html).toMatch(/<form[^>]*aria-busy="true"/);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>APPLYING…<\/button>/);
    // An earlier failure is not shown while the next request runs.
    expect(render({}, { busy: true, error: 'Fictional failure.' })).not.toContain('Fictional failure.');
  });

  it('a failed request’s detail is shown next to APPLY, which it describes; the announcing alert is the result-set line', () => {
    const html = render({}, { error: 'min_depth_m must not exceed max_depth_m (fictional detail).' });
    expect(html).toMatch(/<button type="submit"[^>]*aria-describedby="filter-apply-error"[^>]*>APPLY<\/button>/);
    expect(html).toMatch(/<p id="filter-apply-error"[^>]*>min_depth_m must not exceed max_depth_m \(fictional detail\)\.<\/p>/);
    expect(tag(html, 'filter-apply-error')).not.toContain('role=');
    expect(tag(render(), 'filter-apply-error')).toBe('');
    expect(render()).toMatch(/<button type="submit" class="[^"]*">APPLY<\/button>/);
  });
});
