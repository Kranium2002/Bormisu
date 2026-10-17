/** Server-rendered FieldRow (fictional values): provenance, readings, spreadsheet cells. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import type { ExtractedValue } from '../../domain/types';
import { NO_SOURCE_REFERENCE } from '../../store/reviewSlice';
import { makeValue } from '../../test/fixtures';
import { FieldRow } from './FieldRow';

const render = (value: ExtractedValue, focused = false) =>
  renderToStaticMarkup(
    <FieldRow uid="bh_TEST" value={value} focused={focused} editing={null} normText={value.value} note={null} canChooseCrs={false} />,
  );

describe('FieldRow', () => {
  it('a value with a source reference can be approved, edited and flagged', () => {
    const html = render(makeValue({ key: K.finalDepth, label: 'Final depth', value: '6.00' }), true);
    expect(html).not.toContain('disabled');
    expect(html).toContain('p.1 · no box');
    expect(html).toContain('Larger source view');
  });

  it('a value without a provenance entry shows no method and disables every action with the reason', () => {
    const html = render(makeValue({ key: K.casing, label: 'Casing', value: '3.00', hasProvenance: false, method: null, page: null }), true);
    expect(html.match(/disabled=""/g)).toHaveLength(6);
    expect(html.split(`title="${NO_SOURCE_REFERENCE}"`).length - 1).toBe(6);
    expect(html).toContain('no source reference');
    expect(html).toContain('The backend sent no method for this value');
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
});
