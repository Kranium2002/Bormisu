/**
 * What the chat drawer shows, as pure functions (tested without a browser): the drawer's off state,
 * tool-progress lines, text with citation markers, the result card's counts and the scope line.
 */
import type { AppState } from '../store/types';
import { toolError, type Citation, type ResultCardData, type Scope } from './types';

/** The header button's and the drawer's reason when the server has no chat model. */
export const CHAT_NOT_CONFIGURED = 'Chat is not configured on the server (no OpenAI key)';
/** Sample mode has no backend to ask: the chat is off (it is never faked). */
export const CHAT_NEEDS_BACKEND = 'Chat needs the backend';
export const CHAT_CONNECTING = 'Connecting to the server…';

/** The id of the header's chat button: closing the drawer gives the focus back to it. */
export const CHAT_BUTTON_ID = 'chat-button';

/** Below this width the drawer is a full-screen sheet: it gets out of the way when the map is needed. */
const NARROW = '(max-width: 767px)';

export function narrowScreen(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches;
  } catch {
    return false;
  }
}

/** Why the chat can't be used now, or null when it can. */
export function chatOffReason(
  s: Pick<AppState, 'health' | 'loadState' | 'chatUnavailable'>,
  sampleMode: boolean,
): string | null {
  if (sampleMode || s.health?.mode === 'sample') return CHAT_NEEDS_BACKEND;
  if (s.health && !s.health.providers.chat) return CHAT_NOT_CONFIGURED;
  if (s.chatUnavailable) return CHAT_NOT_CONFIGURED;
  if (!s.health && s.loadState === 'loading') return CHAT_CONNECTING;
  return null;
}

/* ---------- tool progress ---------- */

/** Running text per server tool (contracts/realtime-and-chat.md 2.4); an unknown tool gets the neutral line. */
const TOOL_TEXT: Record<string, string> = {
  resolve_place: 'Finding the place…',
  search_boreholes: 'Searching boreholes…',
  summarize_boreholes: 'Counting…',
  get_borehole: 'Reading the borehole…',
  search_sources: 'Searching the reports…',
  get_evidence: 'Reading the evidence…',
  propose_correction: 'Preparing a correction for review…',
  prepare_export: 'Preparing the export…',
};
export const TOOL_NEUTRAL = 'Working…';

export type ToolState = 'running' | 'done' | 'failed';

export interface ToolLine {
  id: string;
  text: string;
  state: ToolState;
  /** The failure's message (tool output `error`, or the stream's errorText). */
  error: string | null;
}

/** The fields of an AI SDK tool part the line needs (static `tool-<name>` or `dynamic-tool`). */
export interface ToolPartLike {
  type: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  output?: unknown;
  errorText?: string;
}

/** True for an AI SDK tool part. */
export const isToolPart = (p: { type: string }): boolean => p.type === 'dynamic-tool' || p.type.startsWith('tool-');

export function toolLine(p: ToolPartLike): ToolLine {
  const name = p.type === 'dynamic-tool' ? (p.toolName ?? '') : p.type.slice('tool-'.length);
  const text = TOOL_TEXT[name] ?? TOOL_NEUTRAL;
  const id = p.toolCallId ?? name;
  if (p.state === 'output-error' || p.state === 'output-denied') {
    return { id, text, state: 'failed', error: p.errorText?.trim() || 'The step failed.' };
  }
  if (p.state === 'output-available') {
    const e = toolError(p.output);
    if (e) return { id, text, state: 'failed', error: e.message || e.code };
    return { id, text, state: 'done', error: null };
  }
  return { id, text, state: 'running', error: null };
}

/* ---------- text with citations ---------- */

export type TextSegment = { kind: 'text'; text: string } | { kind: 'cite'; n: number; citation: Citation };

/**
 * Text split at `[n]` markers that name a citation of the message (the n-th, in order); a marker
 * without such a citation stays text.
 */
export function citedText(text: string, citations: Citation[]): TextSegment[] {
  const out: TextSegment[] = [];
  let rest = '';
  let last = 0;
  for (const m of text.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    const citation = citations[n - 1];
    if (!citation) continue;
    rest += text.slice(last, m.index);
    if (rest) out.push({ kind: 'text', text: rest });
    rest = '';
    out.push({ kind: 'cite', n, citation });
    last = (m.index ?? 0) + m[0].length;
  }
  rest += text.slice(last);
  if (rest) out.push({ kind: 'text', text: rest });
  return out;
}

/** Numbers of the citations a message's text refers to. */
export function citedNumbers(texts: string[], citations: Citation[]): Set<number> {
  const used = new Set<number>();
  for (const t of texts) for (const s of citedText(t, citations)) if (s.kind === 'cite') used.add(s.n);
  return used;
}

/** Tooltip and accessible name of a citation chip. */
export function citationLabel(n: number, c: Citation): string {
  const where = c.page != null ? `page ${c.page}` : 'source';
  return c.snippet ? `Source ${n}: ${where}, “${c.snippet}”` : `Source ${n}: ${where}`;
}

/* ---------- result card and scope ---------- */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The result card's counts: "3 boreholes · 2 on the map · 1 not located". */
export function resultCardText(r: ResultCardData): string {
  const parts = [plural(r.count, 'borehole', 'boreholes')];
  if (r.located != null) parts.push(`${r.located} on the map`);
  if (r.unlocated != null && r.unlocated > 0) parts.push(`${r.unlocated} not located`);
  return parts.join(' · ');
}

/** The scope line: "Scope: accepted data only · 2 unreviewed left out · 1 document still processing". */
export function scopeText(s: Scope): string {
  const parts = [`Scope: ${s.included}`];
  if (s.excludedUnreviewed) parts.push(`${s.excludedUnreviewed} unreviewed left out`);
  if (s.unlocatedInScope) parts.push(`${plural(s.unlocatedInScope, 'borehole', 'boreholes')} without a location`);
  if (s.documentsProcessing) parts.push(`${plural(s.documentsProcessing, 'document', 'documents')} still processing`);
  return parts.join(' · ');
}

/** The drawer's text for a failed request. */
export function chatErrorText(e: Error): string {
  if (e instanceof TypeError) return 'The chat could not reach the backend.';
  return e.message.trim() || 'The chat answer failed.';
}
