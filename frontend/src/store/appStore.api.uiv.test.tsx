/**
 * The store over the real API data source with a mocked fetch that answers with the frontend's
 * fictional contract fixtures, shaped as the backend answers (M0 UI verification, uiv-12). The byte
 * transfer of the upload belongs to the data layer (tested there); here the upload answers with the
 * duplicate the backend reports, adapted from the contract fixture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { adaptDocument } from '../data/adapters';
import { createApiSource } from '../data/apiSource';
import type { WireDocument, WireDocumentList, WireHealth, WireUploadAccepted } from '../data/adapters';
import { DocumentCard } from '../screens/queue/DocumentCard';
import { UploadRow } from '../screens/queue/UploadList';
import { fixture } from '../test/contract/wire';
import { useAppStore } from './appStore';
import { readyStore, settle } from './testing';

const st = () => useAppStore.getState();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('uiv-12: uploading bytes that were uploaded before', () => {
  it('points the upload at the existing document: no second card, no link from the document to itself', async () => {
    const existing = fixture<WireDocument>('document');
    const duplicate = fixture<WireUploadAccepted>('upload-duplicate');
    // The backend answers a duplicate with the existing document's id in both fields.
    expect(duplicate.document_id).toBe(existing.document_id);
    expect(duplicate.duplicate_of).toBe(existing.document_id);
    const fetch = vi.fn(async (url: string) => {
      const path = url.replace('/api/v1', '');
      if (path === '/health') return json(fixture<WireHealth>('health-live'));
      if (path.startsWith('/boreholes')) return json({ count: 0, boreholes: [], next_cursor: null });
      if (path.startsWith('/map/boreholes.geojson')) return json({ type: 'FeatureCollection', features: [] });
      if (path === '/documents') return json({ documents: [existing] } satisfies WireDocumentList);
      if (path === `/documents/${existing.document_id}`) return json(existing);
      return json({ detail: 'No such route.', code: 'route_not_found' }, 404);
    });
    vi.stubGlobal('fetch', fetch);
    const api = createApiSource('/api/v1');
    api.upload = () => ({ done: Promise.resolve({ document: adaptDocument(existing), duplicate: true }), cancel: () => undefined });
    await readyStore(api);
    expect(st().documents.map((d) => d.id)).toEqual([existing.document_id]);

    st().addFiles([new File(['%PDF fictional'], 'copy_of_report.pdf', { type: 'application/pdf' })]);
    await settle();

    // Still one card: the existing document, with what the backend reports about it.
    expect(st().documents).toHaveLength(1);
    const card = st().documents[0];
    expect(card).toMatchObject({ id: existing.document_id, name: existing.file_name });
    expect(card.pages.length).toBe(existing.pages.length);
    // The upload says so and points at that card.
    const item = st().uploads[0];
    expect(item).toMatchObject({ status: 'done', duplicate: true, documentId: existing.document_id });
    const row = renderToStaticMarkup(
      <UploadRow
        item={item}
        retryBlocked={null}
        documentListed
        onCancel={() => undefined}
        onRemove={() => undefined}
        onRetry={() => undefined}
        onShowDocument={() => undefined}
      />,
    );
    expect(row).toContain('Already uploaded');
    expect(row).toContain('SHOW DOCUMENT');
    // The card does not point at itself.
    const html = renderToStaticMarkup(<DocumentCard doc={card} onShowDocument={() => undefined} />);
    expect(html).not.toMatch(/<button[^>]*>Same file as/);
  });
});
