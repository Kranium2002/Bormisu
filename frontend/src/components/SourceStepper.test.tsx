// @vitest-environment jsdom
/** ‹ source i of N · page n ›: its group, texts, disabled ends and what a press steps to. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceStepper } from './SourceStepper';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('SourceStepper', () => {
  it('names its group and buttons and says which source and page it shows', () => {
    const html = renderToStaticMarkup(<SourceStepper index={1} count={3} page={8} onStep={() => undefined} />);
    expect(html).toContain('role="group" aria-label="Sources of this value"');
    expect(html).toContain('source 2 of 3 · page 8');
    expect(html).not.toMatch(/aria-label="Previous source" disabled=""/);
    expect(html).not.toMatch(/aria-label="Next source" disabled=""/);
  });

  it('disables the button at either end', () => {
    expect(renderToStaticMarkup(<SourceStepper index={0} count={2} page={1} onStep={() => undefined} />)).toMatch(/aria-label="Previous source" disabled=""/);
    expect(renderToStaticMarkup(<SourceStepper index={1} count={2} page={2} onStep={() => undefined} />)).toMatch(/aria-label="Next source" disabled=""/);
  });

  it('steps to the previous and the next source', async () => {
    const onStep = vi.fn();
    document.body.innerHTML = '<div id="app"></div>';
    root = createRoot(document.querySelector('#app')!);
    await act(async () => root!.render(<SourceStepper index={1} count={3} page={8} onStep={onStep} className="extra" />));
    expect(document.querySelector('[role="group"]')?.className).toContain('extra');
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Next source"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Previous source"]')!.click());
    expect(onStep.mock.calls).toEqual([[2], [0]]);
  });
});
