import { describe, expect, it } from 'vitest';
import { fileSlug } from './download';

describe('fileSlug (every downloaded file name)', () => {
  it('ASCII only: accents, compatibility forms and special letters fold, other runs become one "_"', () => {
    expect(fileSlug('Area: Rectangle, 19.46 km²', 'x')).toBe('Area_Rectangle_19_46_km2');
    expect(fileSlug('Bohrung Ü1 – Straße', 'x')).toBe('Bohrung_U1_Strasse');
    expect(fileSlug('Ørsted Æble Łódź', 'x')).toBe('Orsted_AEble_Lodz');
    expect(fileSlug('BK-07/2 (neu).', 'x')).toBe('BK-07_2_neu');
  });

  it('never leaves non-ASCII, a path or nothing', () => {
    for (const s of ['日本語', '../..', '  ', '***']) expect(fileSlug(s, 'fallback')).toBe('fallback');
    expect(fileSlug('Trasse 北 Nord', 'x')).toBe('Trasse_Nord');
    expect(fileSlug('x'.repeat(100), 'x', 10)).toBe('x'.repeat(10));
    expect(fileSlug('abcdefgh_ij', 'x', 9)).toBe('abcdefgh');
  });
});
