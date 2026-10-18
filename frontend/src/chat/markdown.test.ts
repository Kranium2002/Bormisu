import { describe, expect, it } from 'vitest';
import { inlineMarkdown, markdownBlocks } from './markdown';

describe('chat markdown subset', () => {
  it('paragraphs keep their line breaks; a blank line starts the next one', () => {
    expect(markdownBlocks('One\ntwo\n\nThree')).toEqual([
      { kind: 'p', lines: ['One', 'two'] },
      { kind: 'p', lines: ['Three'] },
    ]);
  });

  it('bullet and numbered lists, with the numbering kept and indented continuations joined', () => {
    expect(markdownBlocks('Layers:\n- **0–4 m:** Fill\n* Gravel\n  with sand\n• Silt\n3. third\n4) fourth')).toEqual([
      { kind: 'p', lines: ['Layers:'] },
      { kind: 'ul', items: ['**0–4 m:** Fill', 'Gravel with sand', 'Silt'] },
      { kind: 'ol', start: 3, items: ['third', 'fourth'] },
    ]);
  });

  it('a line between list items keeps its place', () => {
    expect(markdownBlocks('- a\nnote\n- b')).toEqual([
      { kind: 'ul', items: ['a'] },
      { kind: 'p', lines: ['note'] },
      { kind: 'ul', items: ['b'] },
    ]);
  });

  it('bold, italic and code; unclosed or spaced marks stay text', () => {
    expect(inlineMarkdown('at **98 m**, *mostly* gravel, `rs_01`')).toEqual([
      { kind: 'text', text: 'at ' },
      { kind: 'strong', text: '98 m' },
      { kind: 'text', text: ', ' },
      { kind: 'em', text: 'mostly' },
      { kind: 'text', text: ' gravel, ' },
      { kind: 'code', text: 'rs_01' },
    ]);
    expect(inlineMarkdown('__bold__ and _it_')).toEqual([
      { kind: 'strong', text: 'bold' },
      { kind: 'text', text: ' and ' },
      { kind: 'em', text: 'it' },
    ]);
    expect(inlineMarkdown('streaming **98 m')).toEqual([{ kind: 'text', text: 'streaming **98 m' }]);
    expect(inlineMarkdown('2 * 3 * 4 and snake_case_name')).toEqual([{ kind: 'text', text: '2 * 3 * 4 and snake_case_name' }]);
  });

  it('HTML is not a mark: it stays text for React to escape', () => {
    expect(inlineMarkdown('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });
});
