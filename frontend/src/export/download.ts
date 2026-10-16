/** Browser download helpers. */

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

/** Short export file prefix from a source file name: "neckarbogen_BG_2019.pdf" -> "neckarbogen". */
export function exportPrefix(sourceFile: string): string {
  return sourceFile.split(/[_.\s]/)[0] || 'bormisu';
}
