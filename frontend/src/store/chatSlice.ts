/**
 * Chat drawer slice. Placeholder of the M2/M3 foundation: the chat work replaces this file.
 */
import type { SliceCreator } from './context';
import type { ChatSlice } from './types';

export const createChatSlice: SliceCreator<ChatSlice> = ({ set }) => ({
  chatOpen: false,
  chatIncludeUnreviewed: false,
  chatAreaRequest: null,
  chatArea: null,
  openChat: () => set({ chatOpen: true }),
  closeChat: () => set({ chatOpen: false }),
  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  setChatIncludeUnreviewed: (on) => set({ chatIncludeUnreviewed: on }),
  requestChatArea: (prompt) => set({ chatAreaRequest: { prompt } }),
  setChatArea: (area) => set({ chatArea: area, chatAreaRequest: null }),
});
