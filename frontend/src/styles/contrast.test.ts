/**
 * Text contrast of the stylesheets (FRONTEND.md section 6: at least 4.5:1). Every CSS-module rule
 * that sets both a background and a text colour (directly or through a token of tokens.css) is
 * checked with the WCAG 2 formula. Disabled states are exempt (WCAG 1.4.3). Finding uiv-8.
 */
import { describe, expect, it } from 'vitest';

/*
 * The stylesheets are read from disk: Vitest turns CSS-module imports (even `?raw`) into empty
 * objects. The app's tsconfig has no Node types, so the few Node functions used here are typed locally.
 */
interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
}
interface NodePath { join(...parts: string[]): string; relative(from: string, to: string): string }
interface NodeUrl { fileURLToPath(url: URL): string }
const builtin = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }).process.getBuiltinModule;
const { readFileSync, readdirSync, statSync } = builtin('node:fs') as NodeFs;
const { join, relative } = builtin('node:path') as NodePath;
const { fileURLToPath } = builtin('node:url') as NodeUrl;

const SRC = fileURLToPath(new URL('..', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const tokensCss = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8');
const modules: Record<string, string> = Object.fromEntries(
  walk(SRC)
    .filter((p) => p.endsWith('.module.css'))
    .map((p) => [relative(SRC, p).split('\\').join('/'), readFileSync(p, 'utf8')]),
);

const tokens = new Map([...tokensCss.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => [m[1], m[2]]));

/** A colour value as hex, following one token; null for anything else (none, gradients, rgba). */
function hex(value: string): string | null {
  const v = value.trim();
  const token = /^var\((--[\w-]+)\)$/.exec(v);
  if (token) return tokens.get(token[1]) ?? null;
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? v : null;
}

function luminance(colour: string): number {
  let h = colour.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

interface Pair { where: string; fg: string; bg: string; ratio: number }

/** Every rule with both a background colour and a text colour. */
function pairs(): Pair[] {
  const out: Pair[] = [];
  for (const [file, text] of Object.entries(modules)) {
    const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = m[1].trim().replace(/\s+/g, ' ');
      if (selector.includes(':disabled')) continue;
      const bg = /(?:^|[;\s])background(?:-color)?:\s*([^;]+);/.exec(m[2]);
      const fg = /(?:^|[;\s])color:\s*([^;]+);/.exec(m[2]);
      const b = bg && hex(bg[1]);
      const f = fg && hex(fg[1]);
      if (b && f) out.push({ where: `${file} ${selector}`, fg: f, bg: b, ratio: contrast(f, b) });
    }
  }
  return out;
}

describe('text contrast', () => {
  it('computes the WCAG ratio', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#7DB713')).toBeCloseTo(2.43, 2);
  });

  it('finds the coloured rules of the stylesheets', () => {
    expect(pairs().length).toBeGreaterThan(20);
  });

  it('every text on a coloured background reaches 4.5:1 (uiv-8)', () => {
    const low = pairs()
      .filter((p) => p.ratio < 4.5)
      .map((p) => `${p.where}: ${p.fg} on ${p.bg} = ${p.ratio.toFixed(2)}:1`);
    expect(low).toEqual([]);
  });
});
