/**
 * The chat transport (contracts/realtime-and-chat.md section 2): the AI SDK's DefaultChatTransport
 * against POST {api base}/chat. The body is the contract's ChatRequest: the chat id, the messages
 * (AI SDK UIMessage objects) and the context of the moment (context.ts). A RETRY (regenerate) sends
 * the context of the message it repeats, so an area drawn for it is not lost.
 *
 * An error answer (`{detail, code}`, e.g. 409 chat_unavailable) becomes a ChatRequestError with the
 * contract's code, so the drawer branches on the code and shows the detail (never parsing it).
 */
import { DefaultChatTransport } from 'ai';
import type { ChatContext } from './context';
import type { ChatMessage } from './types';

/** An error answer of POST /chat. */
export class ChatRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = 'ChatRequestError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** True for the 409 answer of a server without a chat model. */
export const isChatUnavailable = (e: unknown): boolean => e instanceof ChatRequestError && e.code === 'chat_unavailable';

/** Shown when the server answered without the contract's error body. */
const NO_ANSWER = (status: number) => `The chat request failed (HTTP ${status}).`;

/**
 * fetch for the transport: an OK answer passes through (the stream); an error answer is read as the
 * contract's Error and thrown as a ChatRequestError. A network failure stays the fetch's TypeError.
 */
export function chatFetch(base: typeof fetch = (...args) => globalThis.fetch(...args)): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    if (res.ok) return res;
    let code = '';
    let detail = '';
    try {
      const body = (await res.json()) as { code?: unknown; detail?: unknown };
      if (typeof body?.code === 'string') code = body.code;
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      // Not the contract's JSON (a proxy page): the status says enough.
    }
    throw new ChatRequestError(res.status, code || 'http_error', detail || NO_ANSWER(res.status));
  };
}

export interface TransportOptions {
  /** The API base, e.g. "/api/v1". */
  apiBase: string;
  /** The context for a new message (called once per message sent). */
  context(): ChatContext;
  fetch?: typeof fetch;
}

/** The transport of the app's chat. */
export function createChatTransport(o: TransportOptions): DefaultChatTransport<ChatMessage> {
  let last: ChatContext | null = null;
  return new DefaultChatTransport<ChatMessage>({
    api: `${o.apiBase}/chat`,
    fetch: chatFetch(o.fetch),
    prepareSendMessagesRequest: ({ id, messages, trigger }) => {
      const context = trigger === 'regenerate-message' && last ? last : o.context();
      last = context;
      return { body: { id, messages, context } };
    },
  });
}
