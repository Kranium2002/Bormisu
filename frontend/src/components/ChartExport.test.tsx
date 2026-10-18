// @vitest-environment jsdom
/** Copy / download buttons of a chart: names, tooltips, and what each press does (clipboard, file, toast). */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartExportInfo } from '../export/chartImage';
import { resetTestStore } from './clarify/testStore';
import { ChartExport } from './ChartExport';

vi.mock('../store/appStore', async (importOriginal) => (await import('./clarify/testStore')).mockAppStore(await importOriginal()));

const png = new Blob(['png'], { type: 'image/png' });
const lib = vi.hoisted(() => ({
  canCopy: true,
  copyPng: vi.fn(async (_p: Promise<Blob>) => undefined),
  downloadBlob: vi.fn(),
}));
vi.mock('../export/chartImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../export/chartImage')>()),
  buildChartSvg: () => ({ svg: document.createElementNS('http://www.w3.org/2000/svg', 'svg'), width: 10, height: 10 }),
  svgToPng: async () => png,
  canCopyImage: () => lib.canCopy,
  copyPng: lib.copyPng,
}));
// The file names come from the real fileSlug; only the browser download is replaced.
vi.mock('../export/download', async (importOriginal) => ({ ...(await importOriginal<typeof import('../export/download')>()), downloadBlob: lib.downloadBlob }));

const info: ChartExportInfo = { caption: 'BH AB01 · DIN 4023 profile', legend: [], fileBase: 'BH AB01' };
const showToast = vi.fn();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function press(name: string) {
  const target = createRef<SVGSVGElement>();
  document.body.innerHTML = '<svg id="c"></svg><div id="app"></div>';
  (target as { current: SVGSVGElement | null }).current = document.querySelector('#c');
  root = createRoot(document.querySelector('#app')!);
  await act(async () => root!.render(<ChartExport target={target} info={info} />));
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  await act(async () => button.click());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

beforeEach(() => {
  resetTestStore({ showToast });
  showToast.mockReset();
  lib.copyPng.mockReset().mockResolvedValue(undefined);
  lib.downloadBlob.mockReset();
  lib.canCopy = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('ChartExport', () => {
  it('is a named group of three keyboard-reachable buttons with tooltips, hidden in print', () => {
    const html = renderToStaticMarkup(<ChartExport target={createRef()} info={info} />);
    expect(html).toMatch(/role="group" aria-label="Chart image"/);
    for (const name of ['Copy chart as image', 'Download chart as PNG', 'Download chart as SVG']) {
      expect(html).toContain(`<button type="button"`);
      expect(html).toContain(`aria-label="${name}" title="${name}"`);
    }
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).not.toContain('tabindex="-1"');
  });

  it('COPY puts the PNG on the clipboard and says so', async () => {
    await press('Copy chart as image');
    expect(lib.copyPng).toHaveBeenCalledTimes(1);
    expect(await lib.copyPng.mock.calls[0][0]).toBe(png);
    expect(lib.downloadBlob).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Chart copied');
  });

  it('COPY without the Clipboard API downloads the PNG instead and says so', async () => {
    lib.canCopy = false;
    await press('Copy chart as image');
    expect(lib.copyPng).not.toHaveBeenCalled();
    expect(lib.downloadBlob).toHaveBeenCalledWith(png, 'BH_AB01_profile.png');
    expect(showToast).toHaveBeenCalledWith('Copying images isn’t available here: the chart was downloaded instead');
  });

  it('COPY refused by the browser downloads the PNG instead', async () => {
    lib.copyPng.mockRejectedValue(new Error('NotAllowedError'));
    await press('Copy chart as image');
    expect(lib.downloadBlob).toHaveBeenCalledWith(png, 'BH_AB01_profile.png');
    expect(showToast).toHaveBeenCalledWith('Could not copy to the clipboard: the chart was downloaded instead');
  });

  it('DOWNLOAD saves <name>_profile.png, SVG saves <name>_profile.svg', async () => {
    await press('Download chart as PNG');
    expect(lib.downloadBlob).toHaveBeenCalledWith(png, 'BH_AB01_profile.png');
    expect(showToast).toHaveBeenCalledWith('Chart downloaded');
    lib.downloadBlob.mockReset();
    await press('Download chart as SVG');
    expect(lib.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'BH_AB01_profile.svg');
    expect((lib.downloadBlob.mock.calls[0][0] as Blob).type).toContain('image/svg+xml');
  });
});
