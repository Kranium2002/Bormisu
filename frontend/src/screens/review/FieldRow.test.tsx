/** Server-rendered FieldRow (fictional values): provenance, readings, spreadsheet cells. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import type { ExtractedValue } from '../../domain/types';
import { NO_SOURCE_REFERENCE } from '../../store/reviewSlice';
import { makeValue } from '../../test/fixtures';
import { FieldRow } from './FieldRow';

const render = (value: ExtractedValue, focused = false, questionId: string | null = null) =>
  renderToStaticMarkup(
    <FieldRow uid="bh_TEST" value={value} focused={focused} editing={null} normText={value.value} note={null} canChooseCrs={false} questionId={questionId} />,
  );

describe('FieldRow', () => {
  it('a value with a source reference can be approved, edited and flagged', () => {
    const html = render(makeValue({ key: K.finalDepth, label: 'Final depth', value: '6.00' }), true);
    expect(html).not.toContain('disabled');
    expect(html).toContain('p.1 · no box');
    expect(html).toContain('Larger source view');
  });

  it('a value without a provenance entry says the method is missing (dot tooltip) and disables every action with the reason', () => {
    const html = render(makeValue({ key: K.casing, label: 'Casing', value: '3.00', hasProvenance: false, method: null, page: null }), true);
    expect(html.match(/disabled=""/g)).toHaveLength(6);
    expect(html.split(`title="${NO_SOURCE_REFERENCE}"`).length - 1).toBe(6);
    expect(html).toContain('no source reference');
    expect(html).toContain('the backend sent no method for this value');
  });

  it('shows the readings side by side and a spreadsheet cell instead of a page', () => {
    const v = makeValue({
      key: K.gw(0), label: 'Water strike', value: '1.80', page: null, cell: 'Logdata!C5',
      readings: [
        { reader: 'reader A', text: '1,80', confidence: 0.82 },
        { reader: 'reader B', text: '1,30', confidence: null },
      ],
    });
    const html = render(v);
    expect(html).toContain('Logdata!C5');
    expect(html).toContain('READINGS');
    expect(html).toContain('reader A: “1,80” · 82 %');
    expect(html).toContain('reader B: “1,30”');
  });

  it('READONLY: a read-only value can’t be edited (the reason is the title and description); the rest works', () => {
    const reason = 'Set through the CRS dialog only';
    const html = render(makeValue({ key: K.crs, label: 'CRS', value: 'EPSG:0001', readOnlyReason: reason }), true);
    const edit = html.match(/<button[^>]*aria-label="Edit CRS"[^>]*>/)?.[0] ?? '';
    expect(edit).toContain('disabled=""');
    expect(edit).toContain(`title="${reason}"`);
    expect(edit).toContain(`aria-description="${reason}"`);
    // Approve, flag, the two state buttons and the larger source view stay enabled.
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Approve CRS"');
    expect(html).toContain('aria-label="Flag CRS"');
  });

  it('a value without provenance stays fully read-only, also with a read-only reason', () => {
    const v = makeValue({ key: K.casing, label: 'Casing', value: '3.00', hasProvenance: false, method: null, page: null, readOnlyReason: 'x' });
    const html = render(v, true);
    expect(html.match(/disabled=""/g)).toHaveLength(6);
    expect(html.split(`title="${NO_SOURCE_REFERENCE}"`).length - 1).toBe(6);
  });

  it('F12: a value with an unresolved question shows a Question button, focused or not', () => {
    const v = makeValue({ key: K.finalDepth, label: 'Final depth', value: '6.00' });
    expect(render(v)).not.toContain('Question');
    const html = render(v, false, 'cl_01TESTFICTIONAL');
    expect(html).toMatch(/<button[^>]*aria-label="Question about Final depth"[^>]*>\? Question<\/button>/);
  });

  it('marks a lint the app added itself, so it is not mistaken for a backend finding', () => {
    const own = makeValue({ key: K.spt(1), label: 'SPT', lint: { severity: 'error', message: 'Increments 4 + 5 = 9 ≠ N 8', client: true } });
    expect(render(own)).toContain('✕ Increments 4 + 5 = 9 ≠ N 8 (checked by the app, not the backend)');
    const server = makeValue({ key: K.finalDepth, label: 'Final depth', lint: { severity: 'warning', message: 'Log ends early' } });
    expect(render(server)).toContain('⚠ Log ends early<');
  });
});
