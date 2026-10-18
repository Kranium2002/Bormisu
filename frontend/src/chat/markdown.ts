/**
 * The small markdown subset the chat assistant writes, as plain data for React (no HTML string is ever
 * built, so nothing in the model's text can become markup):
 *
 * - blocks: paragraphs (a blank line between them; single line breaks kept), bullet lists (`- `, `* `,
 *   `• `) and numbered lists (`1. `, `1) `);
 * - inline: **bold** / __bold__, *italic* / _italic_ and `code`.
 *
 * Everything else stays text as written, including an unclosed `**` while the answer streams in.
 */

export type Inline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string };

export type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; start: number; items: string[] };

const BULLET = /^\s{0,3}[-*•]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;

/** The text's blocks in order. */
export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ kind: 'p', lines: para });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      endPara();
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === 'ul') prev.items.push(bullet[1]);
      else blocks.push({ kind: 'ul', items: [bullet[1]] });
    } else if (numbered) {
      endPara();
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === 'ol') prev.items.push(numbered[2]);
      else blocks.push({ kind: 'ol', start: Number(numbered[1]), items: [numbered[2]] });
    } else if (!line.trim()) {
      endPara();
      // A blank line ends a list too: the next item starts a new one.
      blocks.push({ kind: 'p', lines: [] });
    } else if ((last?.kind === 'ul' || last?.kind === 'ol') && !para.length && /^\s{2,}\S/.test(raw)) {
      // An indented line continues the list item above.
      last.items[last.items.length - 1] += ` ${line.trim()}`;
    } else {
      para.push(line);
    }
  }
  endPara();
  return blocks.filter((b) => b.kind !== 'p' || b.lines.length > 0);
}

/**
 * The inline marks of a line. A mark needs a closing partner on the same line and text right inside
 * it (`** x**` is not bold); `_` marks only between non-word characters (snake_case stays as is).
 */
export function inlineMarkdown(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    if (m[1] != null) out.push({ kind: 'code', text: m[1] });
    else if (m[2] != null || m[3] != null) out.push({ kind: 'strong', text: m[2] ?? m[3] });
    else out.push({ kind: 'em', text: m[4] ?? m[5] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}
