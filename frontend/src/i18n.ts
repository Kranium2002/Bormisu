import { create } from 'zustand';

/**
 * UI language: English (default) or German, switched in the header and remembered in this browser.
 * Texts are keyed by their English wording: `t('LIST')` is "LISTE" in German. A text without a German
 * entry stays English, so untranslated screens still work.
 */
export type Lang = 'en' | 'de';

const STORAGE_KEY = 'bormisu.lang';

const DE: Record<string, string> = {
  // header
  'Borehole Intelligence for Herrenknecht': 'Bohrprofil-Analyse für Herrenknecht',
  MAP: 'KARTE',
  LIST: 'LISTE',
  'UPLOAD & QUEUE': 'UPLOAD',
  REVIEW: 'PRÜFUNG',
  Search: 'Suche',
  'Search project or borehole ID': 'Projekt oder Bohrungs-ID suchen',
  // review status
  'REVIEW STATUS': 'PRÜFSTATUS',
  Reviewed: 'Geprüft',
  Unreviewed: 'Ungeprüft',
  'Needs attention': 'Prüfen',
  'Needs attention / CRS inferred': 'Prüfen / Koordinatensystem geschätzt',
  // list
  BOREHOLE: 'BOHRUNG',
  PROJECT: 'PROJEKT',
  STATUS: 'STATUS',
  'FINAL DEPTH': 'ENDTEUFE',
  CRS: 'KOORD.-SYSTEM',
  'ROCK HEAD': 'FELSOBERKANTE',
  LAYERS: 'SCHICHTEN',
  GROUNDWATER: 'GRUNDWASSER',
  'TEST RESULTS': 'LABORWERTE',
  COORDINATES: 'KOORDINATEN',
  'SOURCE FILE': 'QUELLDATEI',
  'NOT ON MAP': 'NICHT AUF KARTE',
  'OPEN DETAIL ›': 'DETAILS ›',
  'Add a column': 'Spalte hinzufügen',
  'No borehole matches the search.': 'Keine Bohrung passt zur Suche.',
  'No boreholes yet. Upload a report under UPLOAD & QUEUE.': 'Noch keine Bohrungen. Lade unter UPLOAD einen Bericht hoch.',
  // detail
  PROFILE: 'PROFIL',
  METADATA: 'METADATEN',
  LOCATION: 'LAGE',
  '› OPEN IN REVIEW': '› IN PRÜFUNG ÖFFNEN',
  'EXPORT ▾': 'EXPORT ▾',
  SAMPLE: 'PROBE',
  'DEPTH (m)': 'TIEFE (m)',
  LAYER: 'SCHICHT',
  RESULTS: 'ERGEBNISSE',
  'No test results in source': 'Keine Laborwerte in der Quelle',
  'no values in source': 'keine Werte in der Quelle',
  CHECK: 'PRÜFUNG',
  'FROM–TO (m)': 'VON–BIS (m)',
  LITHOLOGY: 'LITHOLOGIE',
  Sample: 'Probe',
  'Lab tests': 'Laborversuche',
};

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

/** `t(englishText)` in the current language; re-renders the component when the language changes. */
export function useT(): (en: string) => string {
  const lang = useLang((s) => s.lang);
  return (en) => translate(lang, en);
}
