/**
 * The app's one chat (FRONTEND.md F14): an AI SDK Chat created on first use and kept for the page's
 * life, so closing and reopening the drawer (or changing screens) keeps the conversation. The drawer
 * renders it through useChat({ chat }).
 *
 * - Transient `data-ui-command` parts go to the command dispatcher (commands.ts) as they arrive.
 * - A 409 chat_unavailable marks the chat as not configured (the drawer and the header button say so).
 * - The context of each message is built from the store when it is sent (context.ts).
 */
import { Chat } from '@ai-sdk/react';
import { apiBase } from '../data/createDataSource';
import { useAppStore } from '../store/appStore';
import { runUiCommand } from './commands';
import { buildChatContext, type ChatContext } from './context';
import { ChatRequestError, createChatTransport, isChatUnavailable } from './transport';
import type { ChatMessage } from './types';

/** The map on screen (BoreholeMap's root), measured for "This map area". */
const MAP_SELECTOR = '[role="region"][aria-label="Borehole map"]';

/** The size of the map shown now, or null when no map is shown. */
export function shownMapSize(): { width: number; height: number } | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector<HTMLElement>(MAP_SELECTOR);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
}

/** The context of a message sent now; an area drawn for the chat goes with this message only. */
export function contextNow(): ChatContext {
  const s = useAppStore.getState();
  const context = buildChatContext(s, {
    language: typeof navigator !== 'undefined' ? navigator.language : null,
    mapSize: shownMapSize(),
  });
  if (s.chatArea) s.setChatArea(null);
  return context;
}

/** What the chat does with a data part as it arrives: runs a UI command (transient parts only carry these). */
export function onChatData(part: { type: string; data: unknown }): void {
  if (part.type === 'data-ui-command') runUiCommand(part.data);
}

/** A 409 chat_unavailable marks the chat as not configured; a 401 ends the session (as every other request). */
export function onChatError(error: Error): void {
  if (isChatUnavailable(error)) useAppStore.getState().setChatUnavailable(true);
  else if (error instanceof ChatRequestError && error.code === 'not_authenticated') useAppStore.getState().sessionEnded();
}

let chat: Chat<ChatMessage> | null = null;

/** The app's chat, created on first use. */
export function getChat(): Chat<ChatMessage> {
  chat ??= new Chat<ChatMessage>({
    transport: createChatTransport({ apiBase: apiBase(), context: contextNow }),
    onData: onChatData,
    onError: onChatError,
  });
  return chat;
}
