import type { Borehole } from '../domain/types';

/**
 * The boreholes one export covers: every borehole of the selected borehole's document, or just the
 * borehole when it has no document. The store's exportFile and the export menu's count both use this.
 */
export function exportScope(all: Borehole[], b: Borehole): Borehole[] {
  return b.documentId ? all.filter((x) => x.documentId === b.documentId) : [b];
}
