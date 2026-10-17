/**
 * Opening a source from the chat (citation chips, the open_evidence command): a citation that names
 * a borehole value (uid + path) opens that value's source as the Review screen would (its record is
 * fetched first); anything else opens the cited page of the document with the cited box.
 */
import type { Box } from '../domain/types';
import { useAppStore } from '../store/appStore';
import { keyForPath } from './paths';

export interface EvidenceTarget {
  documentId: string;
  /** Page of the document; null when the source names none. */
  page: number | null;
  box: Box | null;
  uid: string | null;
  path: string | null;
}

export async function openEvidence(t: EvidenceTarget): Promise<void> {
  if (t.uid && t.path) {
    const b = await useAppStore.getState().ensureBorehole(t.uid);
    const key = keyForPath(t.path, b ?? undefined);
    const value = key ? b?.values.find((v) => v.key === key) : undefined;
    if (b && key && value?.hasProvenance) {
      useAppStore.getState().openSource(b.uid, key);
      return;
    }
  }
  useAppStore.getState().showChatEvidence(t.documentId, t.page, t.box);
}
