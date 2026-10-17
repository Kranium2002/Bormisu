import { describe, expect, it } from 'vitest';
import { makeHealth, testFile } from './testing';
import {
  acceptAttribute,
  checkUploads,
  DEMO_UPLOAD_REASON,
  fileExtension,
  formatBytes,
  isFinishedUpload,
  pickedFolder,
  retryBlockedReason,
  uploadBlockedReason,
  uploadHint,
  uploadPercent,
  uploadProject,
  uploadSummary,
} from './uploads';

describe('upload queue helpers', () => {
  it('takes the typed project label, else the folder name, else none', () => {
    expect(uploadProject(' Typed (fictional) ', 'Folder')).toBe('Typed (fictional)');
    expect(uploadProject('', 'Folder (fictional)')).toBe('Folder (fictional)');
    expect(uploadProject('  ', '  ')).toBeNull();
    expect(uploadProject('', null)).toBeNull();
  });

  it('reads the picked folder from webkitRelativePath only when every file shares it', () => {
    expect(pickedFolder([testFile('a.pdf', 1, 'Site A/a.pdf'), testFile('b.pdf', 1, 'Site A/x/b.pdf')])).toBe('Site A');
    expect(pickedFolder([testFile('a.pdf', 1, 'Site A/a.pdf'), testFile('b.pdf', 1, 'Site B/b.pdf')])).toBeNull();
    expect(pickedFolder([testFile('a.pdf', 1, '')])).toBeNull();
    expect(pickedFolder([testFile('a.pdf')])).toBeNull();
    expect(pickedFolder([])).toBeNull();
  });

  it('formats sizes, percentages and the queue summary', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(830_000)).toBe('830 kB');
    expect(formatBytes(12_400_000)).toBe('12.4 MB');
    expect(uploadPercent({ status: 'uploading', loaded: 1, total: 3 })).toBe(33);
    expect(uploadPercent({ status: 'uploading', loaded: 0, total: 0 })).toBe(0);
    expect(uploadPercent({ status: 'done', loaded: 0, total: 0 })).toBe(100);
    expect(uploadSummary([{ status: 'uploading' }, { status: 'queued' }, { status: 'done' }, { status: 'done' }])).toBe(
      '1 uploading · 1 waiting · 2 done',
    );
    expect(uploadSummary([])).toBe('');
    expect(['queued', 'uploading', 'done', 'failed', 'cancelled'].map((s) => isFinishedUpload({ status: s as never }))).toEqual([
      false, false, true, true, true,
    ]);
  });
});

const file = (name: string, bytes = 1) => new File([new Uint8Array(bytes)], name);
const limits = { maxMb: 2, extensions: ['.pdf', '.docx', '.png'] };

describe('upload rules from health', () => {
  it('reads the extension in lower case, with its dot', () => {
    expect(fileExtension('Report.PDF')).toBe('.pdf');
    expect(fileExtension('archive.tar.gz')).toBe('.gz');
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.hidden')).toBe('');
  });

  it('accepts the server’s types up to its size limit and names the rest', () => {
    const files = [file('a.pdf'), file('b.DOCX'), file('c.txt'), file('d.png', 3 * 1024 * 1024), file('e')];
    const r = checkUploads(files, limits);
    expect(r.accepted.map((f) => f.name)).toEqual(['a.pdf', 'b.DOCX']);
    expect(r.error).toBe('File type not supported: c.txt, e · Larger than 2 MB: d.png');
    expect(checkUploads([file('a.pdf')], limits).error).toBe('');
  });

  it('passes everything on when the limits are unknown; the source refuses what the server does not take', () => {
    expect(checkUploads([file('c.txt')], null)).toEqual({ accepted: [expect.any(File)], error: '' });
    expect(acceptAttribute(null)).toBeUndefined();
    expect(uploadHint(null)).toBe('or click to choose files');
  });

  it('builds the chooser filter and the hint from the limits', () => {
    expect(acceptAttribute(limits)).toBe('.pdf,.docx,.png');
    expect(uploadHint(limits)).toBe('or click to choose files · PDF, DOCX, PNG · up to 2 MB each');
  });

  it('blocks uploads in demo mode only', () => {
    expect(uploadBlockedReason(makeHealth({ mode: 'demo' }))).toBe(DEMO_UPLOAD_REASON);
    expect(uploadBlockedReason(makeHealth({ mode: 'live' }))).toBeNull();
    expect(uploadBlockedReason(makeHealth({ mode: 'sample' }))).toBeNull();
    expect(uploadBlockedReason(null)).toBeNull();
  });

  it('BE-RETRY-1: blocks RETRY in demo mode only, with the same reason', () => {
    expect(retryBlockedReason(makeHealth({ mode: 'demo' }))).toBe('Live extraction needs API keys');
    expect(retryBlockedReason(makeHealth({ mode: 'live' }))).toBeNull();
    expect(retryBlockedReason(makeHealth({ mode: 'sample' }))).toBeNull();
    expect(retryBlockedReason(null)).toBeNull();
  });
});
