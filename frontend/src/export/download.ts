/** Browser download helpers. */
import { APP_NAME } from '../config';

/** Saves a blob under a file name via a temporary link. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Letters NFKD doesn't decompose to ASCII, spelled as they are usually written without accents. */
const LETTERS: Record<string, string> = { ß: 'ss', ẞ: 'SS', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', þ: 'th', Þ: 'Th' };

/**
 * The one place file names are made safe: ASCII letters, digits, "-" and "_" only. Accents and
 * compatibility forms fold to their letters ("Ü1" → "U1", "km²" → "km2", "ß" → "ss"), every other run
 * of characters becomes one "_", separators are trimmed from both ends, at most `max` characters;
 * `fallback` when nothing is left (or for "../..").
 */
export function fileSlug(text: string, fallback: string, max = 80): string {
  const folded = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ßẞæÆœŒøØđĐłŁþÞ]/g, (c) => LETTERS[c] ?? '');
  const slug = folded
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, max)
    .replace(/[_-]+$/g, '');
  return slug || fallback;
}

/** Short export file prefix from a source file name: "site_report_2019.pdf" -> "site"; the app name without one. */
export function exportPrefix(sourceFile: string): string {
  return fileSlug(sourceFile.split(/[_.\s]/)[0], fileSlug(APP_NAME.toLowerCase(), 'export'));
}
