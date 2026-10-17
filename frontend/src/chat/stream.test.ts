/**
 * The recorded fictional chat streams (contracts/examples/chat/*.sse) replayed through the AI SDK's
 * own parser: the app's transport (DefaultChatTransport over a mocked fetch) and the AI SDK Chat the
 * drawer renders. Proves the parts arrive as the UI expects (tool parts, data-result-set,
 * data-citation, text with [1], data-scope), the transient UI commands reach onData (and only there),
 * an error chunk becomes the chat's error, and a 409 chat_unavailable marks the chat as not configured.
 */
import { Chat } from '@ai-sdk/react';
import { readUIMessageStream } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/appStore';
import { CHAT_STREAMS, EXAMPLES } from '../test/contract/examples';
import type { ChatContext } from './context';
import { onChatError } from './session';
import { ChatRequestError, createChatTransport, isChatUnavailable } from './transport';
import { parseCitation, parseResultSet, parseScope, type ChatMessage } from './types';
import { chatOffReason, CHAT_NOT_CONFIGURED, toolLine, type ToolPartLike } from './view';

const TURN = CHAT_STREAMS['chat/turn.sse'];
const ERROR = CHAT_STREAMS['chat/error.sse'];
const RS = 'rs_01M54KQD30FJP214PJ45PFT70T';

const CONTEXT: ChatContext = {
  selected_uids: [],
  active_result_set_id: null,
  filters: null,
  map_view: null,
  units: 'm',
  ui_language: 'en',
  include_unreviewed: true,
};

/** The stream answer as the backend sends it. */
const sse = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'cache-control': 'no-cache' },
  });

/** The data of the message's first part of this type. */
const dataOf = (m: ChatMessage, type: string): unknown => (m.parts.find((p) => p.type === type) as { data?: unknown } | undefined)?.data;

const userMessage = (text: string): ChatMessage => ({ id: 'msg_user_test', role: 'user', parts: [{ type: 'text', text }] });

/** The last state of the assistant message parsed from one answer. */
async function replay(body: string, fetchMock = vi.fn(async () => sse(body))): Promise<ChatMessage> {
  const transport = createChatTransport({ apiBase: '/api/v1', context: () => CONTEXT, fetch: fetchMock as unknown as typeof fetch });
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: 'chat_test',
    messageId: undefined,
    messages: [userMessage('Which boreholes near Lindenwick go deeper than 15 m?')],
    abortSignal: undefined,
  });
  let last: ChatMessage | undefined;
  for await (const m of readUIMessageStream<ChatMessage>({ stream })) last = m;
  if (!last) throw new Error('no message');
  return last;
}

describe('the recorded turn (contracts/examples/chat/turn.sse)', () => {
  it('is on this branch', () => {
    expect(TURN).toContain('data: [DONE]');
    expect(ERROR).toContain('"type":"error"');
  });

  it('parses into tool parts, a result set, a citation, text with [1] and the scope, in stream order', async () => {
    const m = await replay(TURN);
    expect(m.role).toBe('assistant');
    expect(m.id).toBe('msg_01M54KQ688M60P3CWM5H2KE1GX');
    const types = m.parts.map((p) => p.type).filter((t) => t !== 'step-start');
    expect(types).toEqual([
      'tool-resolve_place',
      'tool-search_boreholes',
      'data-result-set',
      'tool-get_evidence',
      'data-citation',
      'text',
      'data-scope',
    ]);
    // Transient UI commands are never stored in the message.
    expect(m.parts.some((p) => p.type === 'data-ui-command')).toBe(false);
  });

  it('gives the UI what it renders: progress lines, the card, the chip and the scope line', async () => {
    const m = await replay(TURN);
    const lines = m.parts.filter((p) => p.type.startsWith('tool-')).map((p) => toolLine(p as ToolPartLike));
    expect(lines.map((l) => [l.text, l.state])).toEqual([
      ['Finding the place…', 'done'],
      ['Searching boreholes…', 'done'],
      ['Reading the evidence…', 'done'],
    ]);
    const card = parseResultSet(dataOf(m, 'data-result-set'));
    expect(card).toEqual({ id: RS, count: 1, located: 1, unlocated: 0 });
    const citation = parseCitation(dataOf(m, 'data-citation'));
    expect(citation).toMatchObject({
      documentId: 'doc_01M54BPP80DBVM60TJD6V5NPM0',
      page: 7,
      box: { x: 0.08, y: 0.88, w: 0.24, h: 0.03 },
      uid: 'bh_01M54CB4HGT2NXJXQZD6BE0FGK',
      path: 'metadata.borehole_depth_m',
      snippet: 'Endteufe 18,00 m',
    });
    const text = m.parts.find((p) => p.type === 'text') as { text: string; state?: string };
    expect(text.text).toBe('One uploaded borehole near Lindenwick goes deeper than 15 m: FHL-BH01, 18.00 m deep [1]. It is not reviewed yet, so treat the depth as a draft.');
    expect(text.state).toBe('done');
    const scope = parseScope(dataOf(m, 'data-scope'));
    expect(scope).toEqual({ included: 'accepted and unreviewed data', excludedUnreviewed: 0, unlocatedInScope: 0, documentsProcessing: 3 });
  });

  it('sends the contract’s ChatRequest: id, messages and the context, to POST {api}/chat', async () => {
    const fetchMock = vi.fn(async () => sse(TURN));
    await replay(TURN, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['context', 'id', 'messages']);
    expect(body.id).toBe('chat_test');
    expect(body.context).toEqual(CONTEXT);
    expect(body.messages).toEqual([userMessage('Which boreholes near Lindenwick go deeper than 15 m?')]);
    // The same shape as the contract's example request.
    const example = EXAMPLES['ChatRequest.json'] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(Object.keys(example).sort());
    expect(Object.keys(body.context as object).sort()).toEqual(Object.keys(example.context as object).sort());
  });
});

describe('the AI SDK Chat the drawer renders', () => {
  beforeEach(() => {
    useAppStore.setState({ chatUnavailable: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function chatOver(fetchMock: ReturnType<typeof vi.fn>, onData = vi.fn(), onError = vi.fn()) {
    let n = 0;
    const context = () => ({ ...CONTEXT, selected_uids: [`bh_TEST_${++n}`] });
    const chat = new Chat<ChatMessage>({
      transport: createChatTransport({ apiBase: '/api/v1', context, fetch: fetchMock as unknown as typeof fetch }),
      onData,
      onError,
    });
    return { chat, onData, onError };
  }

  it('hands the transient UI commands to onData in stream order and keeps the persistent parts in the message', async () => {
    const { chat, onData } = chatOver(vi.fn(async () => sse(TURN)));
    await chat.sendMessage({ text: 'Which boreholes near Lindenwick go deeper than 15 m?' });
    expect(chat.status).toBe('ready');
    expect(chat.error).toBeUndefined();
    const commands = onData.mock.calls.map(([p]) => p).filter((p) => p.type === 'data-ui-command');
    expect(commands.map((p) => p.data)).toEqual([
      { command: 'show_result_set', args: { result_set_id: RS } },
      { command: 'fit_result_set', args: { result_set_id: RS } },
    ]);
    expect(commands.every((p) => p.transient === true)).toBe(true);
    const [user, assistant] = chat.messages;
    expect(user.role).toBe('user');
    expect(assistant.parts.some((p) => p.type === 'data-result-set')).toBe(true);
    expect(assistant.parts.some((p) => p.type === 'data-ui-command')).toBe(false);
  });

  it('an error chunk becomes the chat’s error with its errorText; RETRY (regenerate) sends the same context again', async () => {
    const fetchMock = vi.fn(async () => sse(ERROR));
    const { chat, onError } = chatOver(fetchMock);
    await chat.sendMessage({ text: 'How deep is it?' });
    expect(chat.status).toBe('error');
    expect(chat.error?.message).toBe('The chat model did not answer in time. Please try again.');
    expect(onError).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () => sse(TURN));
    await chat.regenerate();
    expect(chat.status).toBe('ready');
    expect(chat.error).toBeUndefined();
    const sent = fetchMock.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)) as { context: ChatContext });
    expect(sent).toHaveLength(2);
    expect(sent[1].context).toEqual(sent[0].context);
    expect(chat.messages.at(-1)?.parts.some((p) => p.type === 'text')).toBe(true);
  });

  it('a 409 chat_unavailable answer is a ChatRequestError with the code, and the chat shows as not configured', async () => {
    const body = EXAMPLES['Error.chat_unavailable.json'];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'application/json' } }));
    const { chat } = chatOver(fetchMock, vi.fn(), vi.fn(onChatError));
    await chat.sendMessage({ text: 'Hello' });
    expect(chat.status).toBe('error');
    expect(chat.error).toBeInstanceOf(ChatRequestError);
    expect(isChatUnavailable(chat.error)).toBe(true);
    expect((chat.error as ChatRequestError).detail).toBe((body as { detail: string }).detail);
    expect(useAppStore.getState().chatUnavailable).toBe(true);
    expect(chatOffReason({ health: null, loadState: 'ready', chatUnavailable: true }, false)).toBe(CHAT_NOT_CONFIGURED);
  });

  it('an error answer without the contract’s body still says what happened', async () => {
    const { chat } = chatOver(vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    await chat.sendMessage({ text: 'Hello' });
    expect(chat.error).toBeInstanceOf(ChatRequestError);
    expect((chat.error as ChatRequestError).code).toBe('http_error');
    expect(chat.error?.message).toBe('The chat request failed (HTTP 502).');
  });
});
