/**
 * Files of a drop that may hold folders. A folder dropped on the zone arrives as a directory entry
 * (DataTransferItem.webkitGetAsEntry); its files are read by walking it recursively. Files dropped
 * together send one project, so the drop's folder name is kept: the name of the one folder dropped,
 * or null when none or several were. Hidden files inside folders (names starting with a dot, e.g.
 * system files) are left out; files dropped one by one are taken as they are.
 */

export interface DroppedFiles {
  files: File[];
  /** Name of the one folder in the drop; null when the drop held no folder or several. */
  folder: string | null;
}

const isFile = (e: FileSystemEntry): e is FileSystemFileEntry => e.isFile;
const isDirectory = (e: FileSystemEntry): e is FileSystemDirectoryEntry => e.isDirectory;
const hidden = (name: string) => name.startsWith('.');

/**
 * The entries of a drop, or null when the browser has none to give (no entry API, or no files).
 * Must run while the drop event is handled: the items are emptied once the handler returns.
 */
export function dropEntries(data: DataTransfer): FileSystemEntry[] | null {
  const items = Array.from(data.items ?? []).filter((i) => i.kind === 'file');
  if (!items.length || typeof items[0].webkitGetAsEntry !== 'function') return null;
  const entries = items.map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => e !== null);
  return entries.length === items.length ? entries : null;
}

/** True when the drop holds at least one folder (then its files must be read through the entries). */
export function hasFolder(entries: FileSystemEntry[] | null): entries is FileSystemEntry[] {
  return !!entries?.some(isDirectory);
}

/** Every entry of a folder: readEntries answers in batches until it returns an empty one. */
function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(all);
          return;
        }
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

async function collect(entry: FileSystemEntry, out: File[], inFolder: boolean): Promise<void> {
  if (inFolder && hidden(entry.name)) return;
  if (isFile(entry)) out.push(await fileOf(entry));
  else if (isDirectory(entry)) for (const child of await readAll(entry)) await collect(child, out, true);
}

/** Reads the files of dropped entries, walking folders recursively, in drop order. */
export async function filesFromEntries(entries: FileSystemEntry[]): Promise<DroppedFiles> {
  const files: File[] = [];
  for (const entry of entries) await collect(entry, files, false);
  const folders = entries.filter(isDirectory);
  return { files, folder: folders.length === 1 ? folders[0].name : null };
}

/** Files of a folder picker without hidden files and folders inside it (e.g. system files). */
export function withoutHiddenFiles(files: File[]): File[] {
  return files.filter((f) => {
    const path = typeof f.webkitRelativePath === 'string' ? f.webkitRelativePath : '';
    return !path.split('/').slice(1).some(hidden);
  });
}
