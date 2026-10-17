/** Server-rendered upload rows (fictional files): progress, status text and the actions of each state. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UploadItem } from '../../store/uploads';
import { UploadRow, uploadStatusText } from './UploadList';

const noop = () => undefined;

const item = (o: Partial<UploadItem> = {}): UploadItem => ({
  id: 'upload-1', name: 'site_log.pdf', size: 2_000_000, project: null, status: 'uploading', loaded: 500_000, total: 2_000_000,
  documentId: null, error: null, duplicate: false, ...o,
});

const row = (o: Partial<UploadItem> = {}, props: { retryBlocked?: string | null; documentListed?: boolean } = {}) =>
  renderToStaticMarkup(
    <UploadRow
      item={item(o)}
      retryBlocked={props.retryBlocked ?? null}
      documentListed={props.documentListed ?? true}
      onCancel={noop}
      onRemove={noop}
      onRetry={noop}
      onShowDocument={noop}
    />,
  );

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe('UploadRow', () => {
  it('a running upload shows its byte progress as a progressbar, and CANCEL', () => {
    const html = row({ project: 'Quay (fictional)' });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Upload of site_log.pdf"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuetext="500 kB of 2.0 MB"');
    expect(html).toContain('width:25%');
    expect(html).toContain('Uploading 25%');
    expect(html).toContain('2.0 MB · Project: Quay (fictional)');
    expect(buttons(html)).toEqual(['CANCEL']);
    expect(html).toContain('aria-label="Cancel upload of site_log.pdf"');
  });

  it('a queued upload waits and can be cancelled', () => {
    const html = row({ status: 'queued', loaded: 0 });
    expect(html).toContain('Waiting');
    expect(html).toContain('aria-valuenow="0"');
    expect(buttons(html)).toEqual(['CANCEL']);
  });

  it('a finished upload shows its document and can be removed', () => {
    const html = row({ status: 'done', documentId: 'doc_NEW', loaded: 2_000_000 });
    expect(html).toContain('Uploaded');
    expect(html).toContain('aria-valuenow="100"');
    expect(buttons(html)).toEqual(['SHOW DOCUMENT', 'REMOVE']);
    // Without a card to point at, there is nothing to show.
    expect(buttons(row({ status: 'done', documentId: 'doc_NEW' }, { documentListed: false }))).toEqual(['REMOVE']);
  });

  it('a duplicate says "Already uploaded" and points at the existing document', () => {
    const html = row({ status: 'done', documentId: 'doc_EARLIER', duplicate: true });
    expect(html).toContain('Already uploaded');
    expect(html).toContain('aria-label="Show the existing document of site_log.pdf"');
    expect(buttons(html)).toEqual(['SHOW DOCUMENT', 'REMOVE']);
  });

  it('a failed upload says why, as an alert, with RETRY and REMOVE', () => {
    const html = row({ status: 'failed', error: 'Backend unreachable' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Failed: Backend unreachable');
    expect(buttons(html)).toEqual(['RETRY', 'REMOVE']);
    expect(html.match(/<button[^>]*>RETRY<\/button>/)?.[0]).not.toContain('disabled');
  });

  it('RETRY is disabled with the reason in demo mode', () => {
    const retry = row({ status: 'failed', error: 'x' }, { retryBlocked: 'Live extraction needs API keys' }).match(/<button[^>]*>RETRY<\/button>/)?.[0];
    expect(retry).toContain('disabled=""');
    expect(retry).toContain('title="Live extraction needs API keys"');
    expect(retry).toContain('aria-description="Live extraction needs API keys"');
  });

  it('a cancelled upload can only be removed', () => {
    const html = row({ status: 'cancelled' });
    expect(html).toContain('Cancelled');
    expect(buttons(html)).toEqual(['REMOVE']);
  });

  it('status texts', () => {
    expect(uploadStatusText(item({ status: 'failed', error: null }))).toBe('Failed: unknown error');
    expect(uploadStatusText(item({ status: 'uploading', loaded: 0, total: 0 }))).toBe('Uploading 0%');
  });
});
