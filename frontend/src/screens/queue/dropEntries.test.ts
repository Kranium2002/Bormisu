/** Reading dropped folders through directory entries (fake entries, fictional file names). */
import { describe, expect, it } from 'vitest';
import { testFile } from '../../store/testing';
import { dropEntries, filesFromEntries, hasFolder, withoutHiddenFiles } from './dropEntries';

/** A fake file entry. */
function fileEntry(name: string): FileSystemEntry {
  return { isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(testFile(name)) } as unknown as FileSystemEntry;
}

/** A fake folder entry whose reader answers in batches of `batch` entries, then an empty batch. */
function dirEntry(name: string, children: FileSystemEntry[], batch = 2): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (ok: (b: FileSystemEntry[]) => void) => {
          const next = children.slice(at, at + batch);
          at += batch;
          setTimeout(() => ok(next), 0);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

describe('dropped folders', () => {
  it('walks a folder recursively, in every batch, and names the drop after it', async () => {
    const site = dirEntry('Site Survey (fictional)', [
      fileEntry('a.pdf'),
      fileEntry('.DS_Store'),
      dirEntry('logs', [fileEntry('b.pdf'), fileEntry('c.png'), fileEntry('d.pdf')]),
      dirEntry('.hidden', [fileEntry('e.pdf')]),
    ]);
    const { files, folder } = await filesFromEntries([site]);
    expect(files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf', 'c.png', 'd.pdf']);
    expect(folder).toBe('Site Survey (fictional)');
  });

  it('a drop of files only has no folder; a drop of two folders names none', async () => {
    expect(await filesFromEntries([fileEntry('a.pdf'), fileEntry('.b.pdf')])).toMatchObject({ folder: null });
    expect((await filesFromEntries([fileEntry('a.pdf'), fileEntry('.b.pdf')])).files.map((f) => f.name)).toEqual(['a.pdf', '.b.pdf']);
    const two = await filesFromEntries([dirEntry('A', [fileEntry('a.pdf')]), dirEntry('B', [fileEntry('b.pdf')])]);
    expect(two).toMatchObject({ folder: null });
    expect(two.files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('a folder with loose files beside it still names the drop after the folder', async () => {
    const r = await filesFromEntries([fileEntry('cover.pdf'), dirEntry('Quay (fictional)', [fileEntry('a.pdf')])]);
    expect(r).toMatchObject({ folder: 'Quay (fictional)' });
    expect(r.files.map((f) => f.name)).toEqual(['cover.pdf', 'a.pdf']);
  });

  it('reads entries from the drop’s items, or none without the entry API', () => {
    const entry = fileEntry('a.pdf');
    const data = { items: [{ kind: 'file', webkitGetAsEntry: () => entry }, { kind: 'string', webkitGetAsEntry: () => null }] } as unknown as DataTransfer;
    expect(dropEntries(data)).toEqual([entry]);
    expect(hasFolder(dropEntries(data))).toBe(false);
    expect(hasFolder([dirEntry('A', [])])).toBe(true);
    expect(dropEntries({ items: [{ kind: 'file' }] } as unknown as DataTransfer)).toBeNull();
    expect(dropEntries({ items: [] } as unknown as DataTransfer)).toBeNull();
  });

  it('leaves hidden files of a picked folder out', () => {
    const files = [
      testFile('a.pdf', 1, 'Site/a.pdf'),
      testFile('.DS_Store', 1, 'Site/.DS_Store'),
      testFile('b.pdf', 1, 'Site/.git/b.pdf'),
      testFile('c.pdf'),
    ];
    expect(withoutHiddenFiles(files).map((f) => f.name)).toEqual(['a.pdf', 'c.pdf']);
  });
});
