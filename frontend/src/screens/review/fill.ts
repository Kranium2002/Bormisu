/** A translator (src/i18n useT / tr); the view models default to English. */
export type Tr = (en: string) => string;
export const EN: Tr = (x) => x;

/**
 * Fills the {placeholders} of a translated text: `fill(t('{n} of {total} values reviewed'), { n, total })`.
 * The English template is the translation key (src/i18n), so a German text can move the numbers around.
 * A placeholder without a value stays as it is.
 */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

/** "1 value" / "3 values": picks the singular or plural template before filling `{n}`. */
export function plural(n: number, one: string, many: string, t: (en: string) => string = (x) => x): string {
  return fill(t(n === 1 ? one : many), { n });
}
