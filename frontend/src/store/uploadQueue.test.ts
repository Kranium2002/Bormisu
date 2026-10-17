/**
 * F6 upload queue in the store, with a fake source whose uploads the test answers by hand
 * (fictional files and documents): two at a time, progress, cancel, remove, retry, the project
 * label, duplicates and demo mode.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { ApiError } from '../data/errors';
import { makeBorehole, makeDocument, makePage } from '../test/fixtures';
import { useAppStore } from './appStore';
import { fakeSource, makeHealth, manualUploads, queuedDocument, readyStore, settle, testFile, type ManualUpload } from './testing';
import { DEMO_UPLOAD_REASON } from './uploads';

const UID = makeBorehole().uid;
const existing = makeDocument({ reviewBoreholeUid: UID });

const st = () => useAppStore.getState();
const items = () => st().uploads;
const statuses = () => items().map((i) => `${i.name}:${i.status}`);

let uploads: ManualUpload[];
let follow: ReturnType<typeof vi.fn<DataSource['follow']>>;

async function ready(over: Partial<DataSource> = {}) {
  const manual = manualUploads();
  uploads = manual.uploads;
  follow = vi.fn<DataSource['follow']>();
  const fake = fakeSource({ boreholes: [makeBorehole()], documents: [existing] }, { upload: manual.upload, follow, ...over });
  await readyStore(fake, UID);
  useAppStore.setState({ health: makeHealth({ upload: { maxMb: 1, extensions: ['.pdf', '.png'] } }) });
  return fake;
}

const answer = (u: ManualUpload, o: Partial<ReturnType<typeof queuedDocument>> = {}, duplicate = false) =>
  u.resolve({ document: { ...queuedDocument(u.file, u.options.project), ...o }, duplicate });

describe('upload queue', () => {
  beforeEach(() => ready());

  it('queues every accepted file and runs at most two uploads at a time', async () => {
    st().addFiles([testFile('a.pdf'), testFile('notes.txt'), testFile('b.pdf'), testFile('c.png')]);
    expect(st().dropError).toBe('File type not supported: notes.txt');
    expect(statuses()).toEqual(['a.pdf:uploading', 'b.pdf:uploading', 'c.png:queued']);
    expect(uploads.map((u) => u.file.name)).toEqual(['a.pdf', 'b.pdf']);
    answer(uploads[0]);
    await settle();
    expect(statuses()).toEqual(['a.pdf:done', 'b.pdf:uploading', 'c.png:uploading']);
    expect(uploads.map((u) => u.file.name)).toEqual(['a.pdf', 'b.pdf', 'c.png']);
  });

  it('a second drop waits behind the running uploads', () => {
    st().addFiles([testFile('a.pdf'), testFile('b.pdf')]);
    st().addFiles([testFile('c.pdf')]);
    expect(statuses()).toEqual(['a.pdf:uploading', 'b.pdf:uploading', 'c.pdf:queued']);
    expect(uploads).toHaveLength(2);
  });

  it('shows byte progress, then the document the server answered with, and follows it', async () => {
    st().addFiles([testFile('a.pdf', 400)]);
    expect(items()[0]).toMatchObject({ name: 'a.pdf', size: 400, loaded: 0, total: 400, project: null, documentId: null });
    uploads[0].progress(100);
    expect(items()[0]).toMatchObject({ loaded: 100, total: 400 });
    uploads[0].progress(300, 410);
    expect(items()[0]).toMatchObject({ loaded: 300, total: 410 });
    answer(uploads[0]);
    await settle();
    expect(items()[0]).toMatchObject({ status: 'done', documentId: 'doc_a.pdf', duplicate: false, error: null, loaded: 410, total: 410 });
    // The new document is a card at the top of the queue, and the source follows it.
    expect(st().documents.map((d) => d.id)).toEqual(['doc_a.pdf', existing.id]);
    expect(follow).toHaveBeenCalledWith('doc_a.pdf');
  });

  it('a live update that arrived before the upload answer is not overwritten by the answer', async () => {
    st().addFiles([testFile('a.pdf')]);
    const pages = [makePage({ n: 1 })];
    const progress = { pagesTotal: 1, pagesClassified: 1, pagesOcrTotal: 0, pagesOcrDone: 0, boreholesExtracted: 0 };
    st().applyLiveEvent({
      type: 'document.updated',
      document: { ...queuedDocument(uploads[0].file, null), status: 'classifying', pages, progress, uploaded: undefined },
    });
    answer(uploads[0]);
    await settle();
    expect(st().documents.filter((d) => d.id === 'doc_a.pdf')).toHaveLength(1);
    expect(st().documents[0]).toMatchObject({ id: 'doc_a.pdf', status: 'classifying', progress, uploaded: true });
    expect(st().documents[0].pages).toHaveLength(1);
  });

  it('a document that is already through extraction is not followed', async () => {
    st().addFiles([testFile('a.pdf')]);
    answer(uploads[0], { status: 'failed', step: 0, error: 'Unreadable file' });
    await settle();
    expect(follow).not.toHaveBeenCalled();
  });

  it('cancels a queued upload without sending it', async () => {
    st().addFiles([testFile('a.pdf'), testFile('b.pdf'), testFile('c.pdf')]);
    st().cancelUpload(items()[2].id);
    expect(statuses()).toEqual(['a.pdf:uploading', 'b.pdf:uploading', 'c.pdf:cancelled']);
    answer(uploads[0]);
    answer(uploads[1]);
    await settle();
    expect(uploads.map((u) => u.file.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('cancels a running upload and starts the next one', async () => {
    st().addFiles([testFile('a.pdf'), testFile('b.pdf'), testFile('c.pdf')]);
    st().cancelUpload(items()[0].id);
    expect(uploads[0].cancelled).toBe(true);
    expect(items()[0].status).toBe('cancelled');
    await settle();
    expect(statuses()).toEqual(['a.pdf:cancelled', 'b.pdf:uploading', 'c.pdf:uploading']);
    expect(items()[0].error).toBeNull();
    expect(st().documents).toHaveLength(1);
  });

  it('an answer that arrives after cancel still counts: the server has the document', async () => {
    st().addFiles([testFile('a.pdf')]);
    const handleCancel = uploads[0];
    // The server answered before the abort reached it (cancel has no effect then).
    answer(handleCancel);
    st().cancelUpload(items()[0].id);
    await settle();
    expect(items()[0]).toMatchObject({ status: 'done', documentId: 'doc_a.pdf' });
    expect(st().documents.map((d) => d.id)).toContain('doc_a.pdf');
  });

  it('removes finished items only', async () => {
    st().addFiles([testFile('a.pdf'), testFile('b.pdf'), testFile('c.pdf')]);
    const [a, b, c] = items();
    st().removeUpload(a.id);
    expect(statuses()).toEqual(['a.pdf:uploading', 'b.pdf:uploading', 'c.pdf:queued']);
    st().cancelUpload(c.id);
    answer(uploads[0]);
    uploads[1].reject(new Error('Backend unreachable'));
    await settle();
    expect(statuses()).toEqual(['a.pdf:done', 'b.pdf:failed', 'c.pdf:cancelled']);
    st().removeUpload(b.id);
    expect(statuses()).toEqual(['a.pdf:done', 'c.pdf:cancelled']);
    st().clearFinishedUploads();
    expect(items()).toEqual([]);
  });

  it('a failed upload says why and can be retried with the same file and project', async () => {
    useAppStore.setState({ uploadProject: 'Harbour Wall (fictional)' });
    st().addFiles([testFile('a.pdf', 10)]);
    uploads[0].progress(5);
    uploads[0].reject(new ApiError(413, 'too_large', 'The file is larger than the server takes.'));
    await settle();
    expect(items()[0]).toMatchObject({ status: 'failed', error: 'The file is larger than the server takes.', loaded: 5 });
    st().retryUpload(items()[0].id);
    expect(items()[0]).toMatchObject({ status: 'uploading', error: null, loaded: 0 });
    expect(uploads).toHaveLength(2);
    expect(uploads[1].file).toBe(uploads[0].file);
    expect(uploads[1].options.project).toBe('Harbour Wall (fictional)');
    answer(uploads[1]);
    await settle();
    expect(items()[0].status).toBe('done');
  });

  it('only failed uploads are retried', () => {
    st().addFiles([testFile('a.pdf')]);
    st().retryUpload(items()[0].id);
    expect(uploads).toHaveLength(1);
  });

  it('a demo_mode refusal shows the demo reason', async () => {
    st().addFiles([testFile('a.pdf')]);
    uploads[0].reject(new ApiError(409, 'demo_mode', 'Uploads are disabled in demo mode.'));
    await settle();
    expect(items()[0]).toMatchObject({ status: 'failed', error: DEMO_UPLOAD_REASON });
  });

  it('a source that throws at once fails that item and goes on with the next', async () => {
    let n = 0;
    const manual = manualUploads();
    uploads = manual.uploads;
    await ready({
      upload: (file, options) => {
        n += 1;
        if (n === 1) throw new Error('Could not read the file');
        return manual.upload(file, options);
      },
    });
    st().addFiles([testFile('a.pdf'), testFile('b.pdf')]);
    await settle();
    expect(statuses()).toEqual(['a.pdf:failed', 'b.pdf:uploading']);
    expect(items()[0].error).toBe('Could not read the file');
  });
});

describe('project label of files dropped together', () => {
  beforeEach(() => ready());

  it('sends the label the user typed with every file of the drop', () => {
    st().setUploadProject('  Quay Extension (fictional)  ');
    st().addFiles([testFile('a.pdf'), testFile('b.pdf')], { folder: 'Folder (fictional)' });
    expect(uploads.map((u) => u.options.project)).toEqual(['Quay Extension (fictional)', 'Quay Extension (fictional)']);
    expect(items().map((i) => i.project)).toEqual(['Quay Extension (fictional)', 'Quay Extension (fictional)']);
  });

  it('else the dropped folder’s name', () => {
    st().addFiles([testFile('a.pdf'), testFile('b.pdf')], { folder: 'Site Survey (fictional)' });
    expect(uploads.map((u) => u.options.project)).toEqual(['Site Survey (fictional)', 'Site Survey (fictional)']);
  });

  it('else the folder chosen with the folder picker (webkitRelativePath)', () => {
    st().addFiles([
      testFile('a.pdf', 1, 'Old Mill (fictional)/a.pdf'),
      testFile('b.pdf', 1, 'Old Mill (fictional)/logs/b.pdf'),
    ]);
    expect(uploads.map((u) => u.options.project)).toEqual(['Old Mill (fictional)', 'Old Mill (fictional)']);
  });

  it('else none', () => {
    st().setUploadProject('   ');
    st().addFiles([testFile('a.pdf', 1, '')]);
    expect(uploads[0].options.project).toBeNull();
    expect(items()[0].project).toBeNull();
  });

  it('a label typed later applies to the next drop only', () => {
    st().addFiles([testFile('a.pdf')]);
    st().setUploadProject('Later (fictional)');
    st().addFiles([testFile('b.pdf')]);
    expect(uploads.map((u) => u.options.project)).toEqual([null, 'Later (fictional)']);
  });
});

describe('duplicate answers', () => {
  beforeEach(() => ready());

  it('say "already uploaded", point at the existing document and add no second card', async () => {
    st().addFiles([testFile('copy.pdf')]);
    uploads[0].resolve({ document: { ...existing, openClarifications: 2 }, duplicate: true });
    await settle();
    expect(items()[0]).toMatchObject({ status: 'done', duplicate: true, documentId: existing.id });
    expect(st().documents).toHaveLength(1);
    // The existing card takes what the server reports about it, and keeps its review target.
    expect(st().documents[0]).toMatchObject({ id: existing.id, openClarifications: 2, reviewBoreholeUid: UID });
    expect(follow).not.toHaveBeenCalled();
  });
});

describe('demo mode', () => {
  it('queues nothing and explains why; a failed item cannot be retried either', async () => {
    await ready();
    st().addFiles([testFile('a.pdf')]);
    uploads[0].reject(new Error('offline'));
    await settle();
    useAppStore.setState({ health: makeHealth({ mode: 'demo' }) });
    st().addFiles([testFile('b.pdf')]);
    expect(st().dropError).toBe(DEMO_UPLOAD_REASON);
    expect(statuses()).toEqual(['a.pdf:failed']);
    st().retryUpload(items()[0].id);
    expect(statuses()).toEqual(['a.pdf:failed']);
    expect(uploads).toHaveLength(1);
  });
});
