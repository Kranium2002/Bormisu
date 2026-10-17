import { expect, it } from 'vitest';
import { translate } from './i18n';

it('translates known texts to German and keeps the rest English', () => {
  expect(translate('de', 'LIST')).toBe('LISTE');
  expect(translate('de', 'Search')).toBe('Suche');
  expect(translate('de', 'some new text')).toBe('some new text');
  expect(translate('en', 'LIST')).toBe('LIST');
});
