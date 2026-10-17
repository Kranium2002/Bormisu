import { describe, expect, it } from 'vitest';
import { makeHealth } from './testing';
import { acceptAttribute, checkUploads, DEMO_UPLOAD_REASON, fileExtension, uploadBlockedReason, uploadHint } from './uploads';

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
});
