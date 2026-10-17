import { create } from 'zustand';
import { base } from './de/base';
import { detail } from './de/detail';
import { list } from './de/list';
import { map } from './de/map';
import { queue } from './de/queue';
import { review } from './de/review';
import { sheet } from './de/sheet';
import { shell } from './de/shell';
import { verify } from './de/verify';

/**
 * UI language: English (default) or German, switched in the header and remembered in this browser.
 * Texts are keyed by their English wording: `t('LIST')` is "LISTE" in German. A text without a German
 * entry stays English, so untranslated screens still work, and tests that read English keep passing.
 *
 * The German texts live in one file per area (src/i18n/de/*.ts) so screens can grow their own without
 * touching each other's; a later file wins over an earlier one for the same English text.
 */
export type Lang = 'en' | 'de';

export const LANGS: readonly Lang[] = ['en', 'de'];

const STORAGE_KEY = 'bormisu.lang';

const DE: Record<string, string> = { ...base, ...shell, ...map, ...list, ...detail, ...sheet, ...review, ...queue, ...verify };

function storedLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'de' ? 'de' : 'en';
  } catch {
    return 'en';
  }
}

export const useLang = create<{ lang: Lang; setLang(lang: Lang): void }>()((set) => ({
  lang: typeof window === 'undefined' ? 'en' : storedLang(),
  setLang(lang) {
    set({ lang });
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // not remembered, still switched
    }
    document.documentElement.lang = lang;
  },
}));

/** Translation of an English UI text in the given language. */
export const translate = (lang: Lang, en: string) => (lang === 'de' ? (DE[en] ?? en) : en);

/** Translation in the current language, for code outside React (store toasts, view models). */
export const tr = (en: string) => translate(useLang.getState().lang, en);

/** `t(englishText)` in the current language; re-renders the component when the language changes. */
export function useT(): (en: string) => string {
  const lang = useLang((s) => s.lang);
  return (en) => translate(lang, en);
}
