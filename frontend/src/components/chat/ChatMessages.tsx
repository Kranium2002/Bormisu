/**
 * The chat transcript's messages, from props (server-rendered in tests): user text, and the assistant's
 * parts in order (FRONTEND.md F14, contracts/realtime-and-chat.md 2.2):
 * - text, with `[n]` markers as numbered citation chips (the n-th data-citation of the message); a
 *   citation the text doesn't refer to is listed as a chip under the answer;
 * - tool parts as short progress lines (running, done, or failed with the tool's error message);
 * - data-result-set as a result card with SHOW ON MAP and OPEN TABLE;
 * - data-scope as a small scope line;
 * - data-clarification as an inline card that opens the question dialog.
 * Text from the stream is rendered as text, never as HTML.
 */
import type { ReactNode } from 'react';
import { chatQuestion } from '../../chat/commands';
import { parseCitation, parseResultSet, parseScope, type ChatMessage, type ChatPart, type Citation } from '../../chat/types';
import {
  citationLabel,
  citedNumbers,
  citedText,
  isToolPart,
  resultCardText,
  scopeText,
  toolLine,
  type ToolLine,
  type ToolPartLike,
} from '../../chat/view';
import styles from './Chat.module.css';

export interface MessageActions {
  /** SHOW ON MAP of a result card. */
  onShowSet(id: string): void;
  /** OPEN TABLE of a result card. */
  onOpenTable(id: string): void;
  /** A citation chip. */
  onCite(c: Citation): void;
  /** The ANSWER button of a clarification card (the part's data). */
  onClarify(data: unknown): void;
}

export function CitationChip({ n, citation, onCite }: { n: number; citation: Citation; onCite(c: Citation): void }) {
  const label = citationLabel(n, citation);
  return (
    <button type="button" className={styles.cite} aria-label={label} title={label} onClick={() => onCite(citation)}>
      {n}
    </button>
  );
}

export function ToolLineView({ line }: { line: ToolLine }) {
  const mark = line.state === 'done' ? '✓' : line.state === 'failed' ? '✕' : '…';
  return (
    <div className={`${styles.tool} ${line.state === 'failed' ? styles.toolFailed : ''}`} data-tool-state={line.state}>
      <span className={styles.toolMark} aria-hidden="true">
        {mark}
      </span>
      <span>
        {line.state === 'failed' ? `${line.text.replace(/…$/, '')} failed` : line.state === 'done' ? line.text.replace(/…$/, '') : line.text}
        {line.error && <span className={styles.toolError}>{`: ${line.error}`}</span>}
      </span>
    </div>
  );
}

export function ResultCard({ data, actions }: { data: unknown; actions: Pick<MessageActions, 'onShowSet' | 'onOpenTable'> }) {
  const r = parseResultSet(data);
  if (!r) return null;
  return (
    <div className={styles.card} data-chat-result-set={r.id}>
      <div className={styles.cardTag}>RESULT SET</div>
      <div className={styles.cardText}>{resultCardText(r)}</div>
      <div className={styles.cardActions}>
        <button type="button" className={styles.primary} onClick={() => actions.onShowSet(r.id)}>
          SHOW ON MAP
        </button>
        <button type="button" className={styles.secondary} onClick={() => actions.onOpenTable(r.id)}>
          OPEN TABLE
        </button>
      </div>
    </div>
  );
}

export function ScopeLine({ data }: { data: unknown }) {
  const s = parseScope(data);
  return s ? <div className={styles.scope}>{scopeText(s)}</div> : null;
}

export function ClarificationCard({ data, onClarify }: { data: unknown; onClarify(data: unknown): void }) {
  const q = chatQuestion(data);
  const question = q?.question ?? (data && typeof data === 'object' && typeof (data as { question?: unknown }).question === 'string' ? (data as { question: string }).question : '');
  const off = q ? null : 'This question can’t be shown here; open it from the INBOX.';
  return (
    <div className={`${styles.card} ${styles.question}`}>
      <div className={styles.cardTag}>QUESTION</div>
      <div className={styles.cardText}>{question || 'The assistant needs an answer to go on.'}</div>
      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.primary}
          aria-disabled={off ? true : undefined}
          title={off ?? undefined}
          onClick={() => {
            if (!off) onClarify(data);
          }}
        >
          ANSWER…
        </button>
      </div>
    </div>
  );
}

/** The `data` of a data part of this type (as untrusted stream data), else undefined. */
const dataOf = (p: ChatPart, type: string): unknown => (p.type === type && 'data' in p ? p.data : undefined);

/** True when the message has something to show (an assistant message can start empty). */
export function hasContent(m: ChatMessage): boolean {
  return m.parts.some((p) => (p.type === 'text' && p.text.trim() !== '') || isToolPart(p) || (p.type.startsWith('data-') && p.type !== 'data-citation'));
}

export function ChatMessageView({ message, actions }: { message: ChatMessage; actions: MessageActions }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return (
      <div className={styles.user} data-role="user">
        {text}
      </div>
    );
  }
  const citations = message.parts.flatMap((p) => {
    const c = p.type === 'data-citation' ? parseCitation(dataOf(p, 'data-citation')) : null;
    return c ? [c] : [];
  });
  const texts = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : []));
  const used = citedNumbers(texts, citations);
  const uncited = citations.map((c, i) => ({ c, n: i + 1 })).filter((x) => !used.has(x.n));
  const blocks: ReactNode[] = [];
  message.parts.forEach((p, i) => {
    const key = `${p.type}-${i}`;
    if (p.type === 'text') {
      if (!p.text) return;
      blocks.push(
        <p key={key} className={styles.text}>
          {citedText(p.text, citations).map((s, j) =>
            s.kind === 'text' ? s.text : <CitationChip key={`c${j}`} n={s.n} citation={s.citation} onCite={actions.onCite} />,
          )}
        </p>,
      );
    } else if (isToolPart(p)) {
      blocks.push(<ToolLineView key={key} line={toolLine(p as ToolPartLike)} />);
    } else if (p.type === 'data-result-set') {
      blocks.push(<ResultCard key={key} data={dataOf(p, p.type)} actions={actions} />);
    } else if (p.type === 'data-scope') {
      blocks.push(<ScopeLine key={key} data={dataOf(p, p.type)} />);
    } else if (p.type === 'data-clarification') {
      blocks.push(<ClarificationCard key={key} data={dataOf(p, p.type)} onClarify={actions.onClarify} />);
    }
  });
  if (uncited.length) {
    blocks.push(
      <div key="sources" className={styles.sources}>
        <span className={styles.sourcesTag}>SOURCES</span>
        {uncited.map(({ c, n }) => (
          <CitationChip key={`s${n}`} n={n} citation={c} onCite={actions.onCite} />
        ))}
      </div>,
    );
  }
  return (
    <div className={styles.assistant} data-role="assistant">
      {blocks}
    </div>
  );
}
