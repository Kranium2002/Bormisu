/**
 * The UI command dispatcher (FRONTEND.md F15, contracts/realtime-and-chat.md section 2.3). The chat
 * stream's transient `data-ui-command` parts arrive here (session.ts onData); only the allowlisted
 * commands run, each through the store's own actions. Anything else is ignored with one console.info.
 *
 * Ids name things the server created; geometry and records are fetched by id. The only coordinates
 * taken from a command are fit_bounds.bbox (it comes from a server tool result); an area inside
 * set_filters' filters is left out for that reason.
 */
import { adaptClarification, adaptFilter } from '../data/adapters';
import { useAppStore } from '../store/appStore';
import { openEvidence } from './evidence';
import { keyForPath } from './paths';
import { pageBox, parseUiCommand, validBbox } from './types';
import { narrowScreen } from './view';

type Args = Record<string, unknown>;

const text = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);
const positiveInt = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 1 ? x : null);

const ignore = (command: string, why: string): false => {
  console.info(`Chat: UI command "${command}" ignored (${why}).`);
  return false;
};

const store = () => useAppStore.getState();

/** fit_result_set: shows the set with a flight to its bbox (also when show_result_set fetched it just before). */
async function fitResultSet(id: string): Promise<void> {
  const before = store().mapOutline?.nonce ?? null;
  await store().showResultSet(id, { fit: true });
  // A show of the same set still running when this came answered without the fit: fit it now.
  const s = store();
  if (s.resultSet?.id === id && (s.mapOutline?.nonce ?? null) === before) await s.showResultSet(id, { fit: true });
}

/** A uid of a borehole of the document that the store knows (pin or record), else after loading the document's records. */
async function boreholeOfDocument(documentId: string): Promise<string | null> {
  const s = store();
  const known = s.features.find((f) => f.documentId === documentId)?.uid ?? s.boreholes.find((b) => b.documentId === documentId)?.uid;
  if (known) return known;
  try {
    return (await s.ensureDocumentBoreholes(documentId))[0]?.uid ?? null;
  } catch {
    return null;
  }
}

async function exportDocument(documentId: string, includeUnreviewed: boolean): Promise<void> {
  const uid = await boreholeOfDocument(documentId);
  if (!uid) {
    store().showToast('No borehole of this report is loaded, so there is nothing to export yet.');
    return;
  }
  await store().ensureBorehole(uid);
  store().openBorehole(uid);
  // The export menu of Detail, preset; the user picks the file and downloads it.
  if (store().includeUnreviewed !== includeUnreviewed) store().toggleIncludeUnreviewed();
  if (!store().exportOpen) store().toggleExport();
}

async function openReviewAt(uid: string, path: string | null): Promise<void> {
  const b = await store().ensureBorehole(uid);
  if (!b) {
    store().showToast('This borehole could not be loaded.');
    return;
  }
  store().openReview(uid);
  const key = keyForPath(path, b);
  if (key) store().focusValue(key, true);
}

async function openQuestion(id: string): Promise<void> {
  if (!store().clarifications.some((c) => c.id === id)) await store().loadClarifications();
  if (store().clarifications.some((c) => c.id === id)) store().openClarification(id);
  else store().showToast('This question is no longer open.');
}

/**
 * Runs one `data-ui-command`'s data. Returns true when the command was accepted (its effect may still
 * be on its way: fetches), false when it was ignored.
 */
export function runUiCommand(data: unknown): boolean {
  const cmd = parseUiCommand(data);
  if (!cmd) return ignore('?', 'not a command');
  const a: Args = cmd.args;
  const s = store();
  switch (cmd.command) {
    case 'show_result_set': {
      const id = text(a.result_set_id);
      if (!id) return ignore(cmd.command, 'no result_set_id');
      void s.showResultSet(id);
      return true;
    }
    case 'fit_result_set': {
      const id = text(a.result_set_id);
      if (!id) return ignore(cmd.command, 'no result_set_id');
      void fitResultSet(id);
      return true;
    }
    case 'fit_bounds': {
      const bbox = validBbox(a.bbox);
      if (!bbox) return ignore(cmd.command, 'no valid bbox');
      s.fitChatBounds(bbox, a.outline === true);
      return true;
    }
    case 'focus_borehole': {
      const uid = text(a.uid);
      if (!uid) return ignore(cmd.command, 'no uid');
      s.focusChatBorehole(uid);
      return true;
    }
    case 'open_detail': {
      const uid = text(a.uid);
      if (!uid) return ignore(cmd.command, 'no uid');
      s.openChatDetail(uid, positiveInt(a.layer));
      return true;
    }
    case 'open_evidence': {
      const documentId = text(a.document_id);
      if (!documentId) return ignore(cmd.command, 'no document_id');
      void openEvidence({ documentId, page: positiveInt(a.page), box: pageBox(a.box), uid: text(a.uid), path: text(a.path) });
      return true;
    }
    case 'open_review': {
      const uid = text(a.uid);
      if (!uid) return ignore(cmd.command, 'no uid');
      void openReviewAt(uid, text(a.path));
      return true;
    }
    case 'set_filters': {
      if (!a.filters || typeof a.filters !== 'object' || Array.isArray(a.filters)) return ignore(cmd.command, 'no filters');
      // Coordinates from a command are not trusted (only fit_bounds.bbox): the filters go without an area.
      const filter = { ...adaptFilter(a.filters as Parameters<typeof adaptFilter>[0]), area: null };
      s.setFilter(filter);
      void store().applyFilter();
      return true;
    }
    case 'open_clarification': {
      const id = text(a.clarification_id);
      if (!id) return ignore(cmd.command, 'no clarification_id');
      void openQuestion(id);
      return true;
    }
    case 'request_area': {
      const prompt = text(a.prompt);
      if (!prompt) return ignore(cmd.command, 'no prompt');
      s.requestChatArea(prompt);
      if (store().screen !== 'map') store().go('map');
      // A full-screen drawer would hide the map the area is drawn on.
      if (narrowScreen()) store().closeChat();
      return true;
    }
    case 'export_document': {
      const documentId = text(a.document_id);
      if (!documentId) return ignore(cmd.command, 'no document_id');
      void exportDocument(documentId, a.include_unreviewed === true);
      return true;
    }
    default:
      return ignore(cmd.command, 'not in the allowlist');
  }
}

/** The question a `data-clarification` part carries, or null when this client can't show it. */
export const chatQuestion = (data: unknown) => adaptClarification(data);

/**
 * Opens the dialog of a question the chat sent (`data-clarification`): added to the store's list
 * first when it isn't there. Returns false when the data isn't a question this client can show.
 */
export function openChatClarification(data: unknown): boolean {
  const question = adaptClarification(data);
  if (!question) return false;
  store().addChatClarification(question);
  store().openClarification(question.id);
  return true;
}
