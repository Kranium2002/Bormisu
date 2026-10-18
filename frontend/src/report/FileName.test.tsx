import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileName, SourceText } from './ReportScreen';

describe('file names in the report', () => {
  it('may break after "_", "-" and "." only (a <wbr> after each), never inside a word', () => {
    expect(renderToStaticMarkup(<FileName name="fictional_site_records.csv" />)).toBe('fictional_<wbr/>site_<wbr/>records.<wbr/>csv');
    expect(renderToStaticMarkup(<FileName name="BH-0042" />)).toBe('BH-<wbr/>0042');
    expect(renderToStaticMarkup(<FileName name="report" />)).toBe('report');
  });

  it('the source cell: file and page, the file breakable', () => {
    expect(renderToStaticMarkup(<SourceText lang="en" source={{ file: 'a_b.pdf', page: 3 }} />)).toBe('a_<wbr/>b.<wbr/>pdf · p. 3');
    expect(renderToStaticMarkup(<SourceText lang="en" source={{ file: '', page: null }} />)).toBe('an upload');
  });
});
