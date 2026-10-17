/** Number formatting and parsing for depths and values. */

/** Formats a number with a decimal comma, as printed in German logs: 18 -> "18,00". */
export function decimalComma(v: number, digits = 2): string {
  return v.toFixed(digits).replace('.', ',');
}

/** Formats a depth in metres: 11.2 -> "11.20 m". Null gives an empty string (a blank never means 0). */
export function metres(v: number | null | undefined, digits = 2): string {
  return v == null ? '' : `${v.toFixed(digits)} m`;
}

/**
 * Parses a normalised or printed number: "18.00", "18,00", "3 513 420" -> number.
 * Returns null for anything that isn't a plain number.
 */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}
