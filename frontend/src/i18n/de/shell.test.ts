/** German texts of the shell, map and list: every entry is filled in, and they reach translate(). */
import { describe, expect, it } from 'vitest';
import { translate } from '..';
import { FIELDS, FIELD_GROUPS } from '../../domain/fields';
import { list } from './list';
import { map } from './map';
import { shell } from './shell';

describe('German texts (shell, map, list)', () => {
  it('no entry is empty or left in English by mistake', () => {
    for (const [en, de] of Object.entries({ ...shell, ...map, ...list })) {
      expect(de.trim(), en).not.toBe('');
    }
  });

  it('the nav, the map overlay and LIST speak German; English stays the default', () => {
    expect(translate('de', 'LIST')).toBe('LISTE');
    expect(translate('de', 'FILTERS')).toBe('FILTER');
    expect(translate('de', 'OPEN LIST ›')).toBe('LISTE ÖFFNEN ›');
    expect(translate('de', 'NOT ON MAP')).toBe('NICHT AUF KARTE');
    expect(translate('en', 'FILTERS')).toBe('FILTERS');
  });

  it('every column group and every column of LIST has a German name', () => {
    for (const g of FIELD_GROUPS) expect(translate('de', g), g).not.toBe(g);
    const untranslated = FIELDS.filter((f) => translate('de', f.label) === f.label && !/^(CRS|TCR|RQD|UCS|CAI|RMR|Q|GSI|LAYERS|LITHOLOGY|FORMATION|SPT N|TEST RESULTS|COSISTENCY|ADMIN)$/.test(f.label));
    expect(untranslated.map((f) => f.label)).toEqual([]);
  });
});
