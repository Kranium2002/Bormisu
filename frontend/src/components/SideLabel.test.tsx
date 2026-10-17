/** The names of the two sides of a page view (fictional file): ORIGINAL as uploaded, RECONSTRUCTED from the values. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import { originalLabel, OriginalLabel, ReconstructedLabel } from './SideLabel';

describe('side labels', () => {
  it('names the original with its file and page, as uploaded', () => {
    const en = (s: string) => s;
    expect(originalLabel(en, 'fictional-report.pdf', 7)).toBe('ORIGINAL · fictional-report.pdf, page 7 (as uploaded)');
    expect(originalLabel(en, null, 7)).toBe('ORIGINAL · page 7 (as uploaded)');
    expect(originalLabel(en, 'fictional-report.pdf', null)).toBe('ORIGINAL · fictional-report.pdf (as uploaded)');
  });

  it('builds the label from parts, so it translates', () => {
    const de = (s: string) => translate('de', s);
    expect(originalLabel(de, 'fictional-report.pdf', 7)).toBe('ORIGINAL · fictional-report.pdf, Seite 7 (wie hochgeladen)');
    expect(de('RECONSTRUCTED')).toBe('REKONSTRUIERT');
    expect(de('from extracted values')).toBe('aus den ausgelesenen Werten');
    expect(de('Loading the original scan…')).toBe('Originalscan wird geladen…');
    expect(de('Original page could not be loaded')).toBe('Originalseite konnte nicht geladen werden');
  });

  it('renders the side’s name apart from the rest', () => {
    expect(renderToStaticMarkup(<OriginalLabel file="fictional-report.pdf" page={7} />)).toMatch(/>ORIGINAL<\/span> · fictional-report\.pdf, page 7 \(as uploaded\)<\/span>$/);
    expect(renderToStaticMarkup(<ReconstructedLabel />)).toMatch(/>RECONSTRUCTED<\/span> · from extracted values<\/span>$/);
  });
});
