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

/** Short export file prefix from a source file name: "site_report_2019.pdf" -> "site"; the app name without one. */
export function exportPrefix(sourceFile: string): string {
  return sourceFile.split(/[_.\s]/)[0] || APP_NAME.toLowerCase();
}
