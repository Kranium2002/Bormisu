/**
 * Server-rendered chat transcript parts (FRONTEND.md F14, contracts/realtime-and-chat.md 2.2) from
 * the recorded fictional turn and hand-made parts: text with numbered citation chips, tool-progress
 * lines (running, done, failed with the tool's message, unknown tools neutral), the result card, the
 * scope line and the question card; stream text is rendered as text. Plus the header button's and
 * the area hint's states. Actions are tested in src/chat/cardActions.test.ts and the e2e suites.
 */
import { readUIMessageStream } from 'ai';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createChatTransport } from '../../chat/transport';
import type { ChatMessage } from '../../chat/types';
import { CHAT_NEEDS_BACKEND, CHAT_NOT_CONFIGURED } from '../../chat/view';
import { CHAT_STREAMS, EXAMPLES } from '../../test/contract/examples';
import { ChatButtonView } from '../header/ChatButton';
import { ChatAreaHint } from './ChatAreaHint';
import { ChatMessageView, hasContent, type MessageActions } from './ChatMessages';

const noop = () => undefined;
const ACTIONS: MessageActions = { onShowSet: noop, onOpenTable: noop, onCite: noop, onClarify: noop };

const render = (message: ChatMessage) => renderToStaticMarkup(<ChatMessageView message={message} actions={ACTIONS} />);
const assistant = (parts: ChatMessage['parts']): ChatMessage => ({ id: 'msg_test', role: 'assistant', parts });
/** Text content of rendered markup (tags dropped, the few entities React writes decoded). */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

async function recordedTurn(): Promise<ChatMessage> {
  const fetchMock = async () =>
    new Response(CHAT_STREAMS['chat/turn.sse'], { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
  const transport = createChatTransport({
    apiBase: '/api/v1',
    context: () => ({ selected_uids: [], active_result_set_id: null, filters: null, map_view: null, units: 'm', ui_language: null, include_unreviewed: false }),
    fetch: fetchMock as unknown as typeof fetch,
  });
  const stream = await transport.sendMessages({ trigger: 'submit-message', chatId: 'c', messageId: undefined, messages: [], abortSignal: undefined });
  let last: ChatMessage | undefined;
  for await (const m of readUIMessageStream<ChatMessage>({ stream })) last = m;
  return last!;
}

describe('the recorded turn', () => {
  it('renders the progress lines, the result card, the text with chip 1 and the scope line, in order', async () => {
    const html = render(await recordedTurn());
    const text = textOf(html);
    const order = ['Finding the place', 'Searching boreholes', 'RESULT SET', '1 borehole · 1 on the map', 'SHOW ON MAP', 'OPEN TABLE', 'Reading the evidence', 'FHL-BH01, 18.00 m deep', 'Scope: accepted and unreviewed data'];
    let at = -1;
    for (const s of order) {
      const i = text.indexOf(s, at + 1);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    // [1] became chip 1 (named by the citation), no literal marker is left.
    expect(text).not.toContain('[1]');
    expect(html).toContain('aria-label="Source 1: page 7, “Endteufe 18,00 m”"');
    expect(html).toMatch(/<button[^>]*aria-label="Source 1[^"]*"[^>]*>1<\/button>/);
    // Every tool finished: three done marks, none running or failed.
    expect(html.match(/data-tool-state="done"/g)).toHaveLength(3);
    expect(html).not.toContain('data-tool-state="failed"');
    expect(text).toContain('3 documents still processing');
    expect(html).toContain('data-chat-result-set="rs_01M54KQD30FJP214PJ45PFT70T"');
  });
});

describe('parts', () => {
  it('a running tool shows its line; an unknown tool gets the neutral line', () => {
    const html = render(
      assistant([
        { type: 'tool-summarize_boreholes', toolCallId: 'c1', state: 'input-available', input: {} } as never,
        { type: 'dynamic-tool', toolName: 'some_future_tool', toolCallId: 'c2', state: 'input-available', input: {} } as never,
      ]),
    );
    expect(textOf(html)).toContain('Counting…');
    expect(textOf(html)).toContain('Working…');
    expect(html.match(/data-tool-state="running"/g)).toHaveLength(2);
  });

  it('a tool whose output is an error shows as a failed step with the message', () => {
    const html = render(
      assistant([
        {
          type: 'tool-resolve_place',
          toolCallId: 'c1',
          state: 'output-available',
          input: { query: 'Nowhere' },
          output: { error: { code: 'geocoder_unavailable', message: 'Place search is not available right now.' } },
        } as never,
      ]),
    );
    expect(html).toContain('data-tool-state="failed"');
    expect(textOf(html)).toContain('Finding the place failed: Place search is not available right now.');
  });

  it('stream text is text, never markup', () => {
    const html = render(assistant([{ type: 'text', text: '<img src=x onerror=alert(1)> and [7] without a citation', state: 'done' }]));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(textOf(html)).toContain('[7] without a citation');
  });

  it('the markdown subset of an answer becomes bold, lists and code; HTML inside it stays text', () => {
    const answer = [
      'The deepest borehole is **FX-12 — Fictional Well 1**, at **98 m**.',
      '',
      'Its layers:',
      '- **0–4 m:** Fill with *brick* fragments',
      '- **4–10 m:** Sandy gravel <b>x</b>',
      '1. first',
      '2. `code_name`',
    ].join('\n');
    const html = render(assistant([{ type: 'text', text: answer, state: 'done' }]));
    expect(html).toContain('<strong>FX-12 — Fictional Well 1</strong>');
    expect(html).toContain('<strong>98 m</strong>');
    expect(html).toMatch(/<ul[^>]*><li><strong>0–4 m:<\/strong> Fill with <em>brick<\/em> fragments<\/li><li>/);
    expect(html).toMatch(/<ol[^>]* start="1"><li>first<\/li><li><code[^>]*>code_name<\/code><\/li><\/ol>/);
    expect(html).not.toContain('**');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('citations the text does not mark are listed as chips under the answer', () => {
    const html = render(
      assistant([
        { type: 'text', text: 'The depth is stated in the report.', state: 'done' },
        { type: 'data-citation', id: 'c1', data: { citation_id: 'c1', document_id: 'doc_TEST_1', page: 2, box: null, snippet: 'Endteufe' } },
      ]),
    );
    expect(textOf(html)).toContain('SOURCES');
    expect(html).toContain('aria-label="Source 1: page 2, “Endteufe”"');
  });

  it('the result card shows the unlocated count when there are some', () => {
    const html = render(assistant([{ type: 'data-result-set', id: 'rs', data: { result_set_id: 'rs_TEST', count: 4, located_count: 2, unlocated_count: 2, bbox: null } }]));
    expect(textOf(html)).toContain('4 boreholes · 2 on the map · 2 not located');
  });

  it('a result-set part that is not the contract’s shape renders nothing', () => {
    const html = render(assistant([{ type: 'data-result-set', id: 'rs', data: { count: 'many' } as never }]));
    expect(html).not.toContain('SHOW ON MAP');
  });

  it('a question card shows the question with ANSWER…; one this client cannot show is off with the reason', () => {
    const ok = render(assistant([{ type: 'data-clarification', id: 'q', data: EXAMPLES['Clarification.chat_parameter.json'] }]));
    expect(textOf(ok)).toContain('Which Lindenwick do you mean?');
    expect(ok).toMatch(/<button[^>]*>ANSWER…<\/button>/);
    expect(ok).not.toContain('aria-disabled');
    const off = render(assistant([{ type: 'data-clarification', id: 'q', data: { question: 'Broken question' } }]));
    expect(textOf(off)).toContain('Broken question');
    expect(off).toContain('aria-disabled="true"');
    expect(off).toContain('title="This question can’t be shown here; open it from the INBOX."');
  });

  it('user messages show their text; empty assistant messages are not shown', () => {
    const html = render({ id: 'u', role: 'user', parts: [{ type: 'text', text: 'How deep is CH-1?' }] });
    expect(html).toContain('data-role="user"');
    expect(textOf(html)).toBe('How deep is CH-1?');
    expect(hasContent(assistant([]))).toBe(false);
    expect(hasContent(assistant([{ type: 'step-start' }]))).toBe(false);
    expect(hasContent(assistant([{ type: 'text', text: 'Hi', state: 'streaming' }]))).toBe(true);
  });
});

describe('header button and area hint', () => {
  it('opens the chat; off with the reason as its tooltip (still focusable)', () => {
    const on = renderToStaticMarkup(<ChatButtonView open={false} offReason={null} onToggle={noop} />);
    expect(on).toContain('title="Ask the chat assistant"');
    expect(on).toContain('aria-expanded="false"');
    expect(on).not.toContain('aria-disabled');
    const off = renderToStaticMarkup(<ChatButtonView open={false} offReason={CHAT_NOT_CONFIGURED} onToggle={noop} />);
    expect(off).toContain('aria-disabled="true"');
    expect(off).toContain('title="Chat is not configured on the server (no OpenAI key)"');
    const sample = renderToStaticMarkup(<ChatButtonView open={false} offReason={CHAT_NEEDS_BACKEND} onToggle={noop} />);
    expect(sample).toContain('title="Chat needs the backend"');
    // An open drawer can always be closed from the button.
    const open = renderToStaticMarkup(<ChatButtonView open offReason={CHAT_NOT_CONFIGURED} onToggle={noop} />);
    expect(open).not.toContain('aria-disabled');
    expect(open).toContain('title="Close the chat"');
  });

  it('the area hint shows the prompt as text, DRAW when not drawing, and CANCEL', () => {
    const idle = renderToStaticMarkup(<ChatAreaHint prompt="Which <b>area</b>?" drawing={false} onDraw={noop} onCancel={noop} />);
    expect(idle).toContain('Which &lt;b&gt;area&lt;/b&gt;?');
    expect(idle).toMatch(/>DRAW<\/button>/);
    expect(idle).toMatch(/>CANCEL<\/button>/);
    const drawing = renderToStaticMarkup(<ChatAreaHint prompt="Which area?" drawing onDraw={noop} onCancel={noop} />);
    expect(drawing).not.toMatch(/>DRAW<\/button>/);
    expect(drawing).toContain('Click two opposite corners');
  });
});
