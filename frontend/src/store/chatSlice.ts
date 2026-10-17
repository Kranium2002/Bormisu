/**
 * Chat slice (FRONTEND.md F14, F15): the drawer (open, the include-unreviewed and "this map area"
 * switches, the not-configured state after a 409 chat_unavailable), request_area (the hint the map
 * shows and the area drawn for the chat), and the store actions the chat's command dispatcher
 * (src/chat/commands.ts) needs beyond the other slices': a bbox to fly to, a borehole to focus on the
 * map, Detail at a layer, the Source panel at a page and box, and a question the chat sent.
 *
 * The conversation itself (messages, streaming, errors) lives in the AI SDK chat, not here.
 */
import { LEAVE_REVIEW, nextNonce, type SliceCreator } from './context';
import type { ChatSlice } from './types';

/** Longest request_area prompt shown on the map (the text comes from the model). */
const PROMPT_MAX = 240;

export const createChatSlice: SliceCreator<ChatSlice> = (ctx) => {
  const { set, get } = ctx;
  return {
    chatOpen: false,
    chatIncludeUnreviewed: false,
    chatUseView: false,
    chatAreaRequest: null,
    chatArea: null,
    chatUnavailable: false,

    openChat: () => set({ chatOpen: true }),
    closeChat: () => set({ chatOpen: false }),
    toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
    setChatIncludeUnreviewed: (on) => set({ chatIncludeUnreviewed: on }),
    setChatUseView: (on) => set({ chatUseView: on }),

    requestChatArea(prompt) {
      const text = prompt.trim().slice(0, PROMPT_MAX);
      set({ chatAreaRequest: { prompt: text }, chatArea: null });
    },

    setChatArea: (area) => set({ chatArea: area, chatAreaRequest: null }),
    cancelChatAreaRequest: () => set({ chatAreaRequest: null }),
    setChatUnavailable: (on) => set({ chatUnavailable: on }),

    fitChatBounds(bbox, outline) {
      set({ mapOutline: { bbox: [...bbox], outline, nonce: nextNonce() } });
      if (get().screen !== 'map') get().go('map');
    },

    focusChatBorehole(uid) {
      const s = get();
      // A borehole without a pin has nothing to show on the map: its Detail screen instead.
      if (!s.features.some((f) => f.uid === uid)) {
        s.openBorehole(uid);
        return;
      }
      if (s.navigator) {
        // The map follows the URL's selection: it reveals the pin and opens its popup.
        s.showRoute({ kind: 'map', at: s.mapView, sel: uid, rs: s.resultSetId });
        return;
      }
      set({ ...LEAVE_REVIEW, screen: 'map', selectedUid: uid, exportOpen: false });
    },

    openChatDetail(uid, layer) {
      const s = get();
      if (s.navigator) {
        s.showRoute({ kind: 'detail', uid, layer });
        return;
      }
      s.openBorehole(uid);
      if (layer != null) get().selectLayer(layer);
    },

    showChatEvidence(documentId, page, box) {
      set({ panel: { kind: 'source', documentId, page, box, ...(box ? {} : { pageOnly: true }) } });
    },

    addChatClarification(question) {
      if (get().clarifications.some((c) => c.id === question.id)) return;
      ctx.clarificationEvents.created(question);
    },
  };
};
