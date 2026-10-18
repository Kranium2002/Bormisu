// @vitest-environment jsdom
/** The chart image export: file names, the stand-alone SVG (patterns inlined, nothing interactive), scale, clipboard. Fictional data only. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DinPatternDefs } from '../components/DinPatternDefs';
import { ProfileColumn, profileExportInfo } from '../screens/detail/ProfileColumn';
import { makeBorehole, makeLayer } from '../test/fixtures';
import { buildChartSvg, canCopyImage, chartFileName, chartMarkup, copyPng, PNG_SCALE, referencedIds, resolveVars, svgToPng } from './chartImage';

const borehole = () =>
  makeBorehole({
    id: 'BH AB01 & <B>',
    layers: [makeLayer({ n: 1, from: 0, to: 2, din: 'T', dinNotation: 'T' }), makeLayer({ n: 2, from: 2, to: 5, din: 'S', dinNotation: 'S, u' })],
  });

/** The page as the app has it: the shared pattern defs, and the drawing with layer 1 selected. */
function mount(): SVGSVGElement {
  const b = borehole();
  document.body.innerHTML =
    renderToStaticMarkup(createElement(DinPatternDefs)) +
    `<div id="chart">${renderToStaticMarkup(createElement(ProfileColumn, { borehole: b, selectedLayer: 1, onSelectLayer: () => undefined, onOpenSource: () => undefined }))}</div>`;
  return document.querySelector('#chart > svg') as SVGSVGElement;
}

const parse = (markup: string) => new DOMParser().parseFromString(markup, 'image/svg+xml');

describe('chartFileName', () => {
  it('turns runs of other characters into one underscore and adds _profile.<ext>', () => {
    expect(chartFileName('BH AB01', 'png')).toBe('BH_AB01_profile.png');
    expect(chartFileName('BK-07/2 (neu).', 'svg')).toBe('BK-07_2_neu_profile.svg');
    expect(chartFileName('  BH:01*?"<>|  ', 'png')).toBe('BH_01_profile.png');
    // ASCII only: accents and symbols fold to their letters (fileSlug).
    expect(chartFileName('Bohrung Ü1', 'png')).toBe('Bohrung_U1_profile.png');
    expect(chartFileName('Area: Rectangle, 19.46 km²', 'png', 'soil-chart')).toBe('Area_Rectangle_19_46_km2_soil-chart.png');
  });

  it('falls back to "borehole" and keeps names short', () => {
    expect(chartFileName('', 'png')).toBe('borehole_profile.png');
    expect(chartFileName('../..', 'png')).toBe('borehole_profile.png');
    expect(chartFileName('x'.repeat(200), 'png')).toBe(`${'x'.repeat(80)}_profile.png`);
  });
});

describe('resolveVars', () => {
  it('replaces var(--x) by its value, else by the fallback', () => {
    const vars: Record<string, string> = { '--c-text': ' #111111 ' };
    const lookup = (n: string) => vars[n] ?? '';
    expect(resolveVars('var(--c-text)', lookup)).toBe('#111111');
    expect(resolveVars('var(--missing, #fff)', lookup)).toBe('#fff');
    expect(resolveVars('1px solid var(--c-text)', lookup)).toBe('1px solid #111111');
  });
});

describe('buildChartSvg', () => {
  it('inlines every pattern the drawing fills with, and only those: the image stands alone', () => {
    const svg = mount();
    const used = [...referencedIds(svg)].filter((id) => id.startsWith('din-'));
    expect(used).toEqual(expect.arrayContaining(['din-soil_T', 'din-soil_S']));
    const doc = parse(chartMarkup(buildChartSvg(svg, profileExportInfo(borehole(), { t: (s) => s }))));
    expect(doc.querySelector('parsererror')).toBeNull();
    const defined = new Set([...doc.querySelectorAll('[id]')].map((e) => e.id));
    for (const id of referencedIds(doc.documentElement)) expect(defined, `url(#${id})`).toContain(id);
    const patterns = [...doc.querySelectorAll('pattern')].map((p) => p.id).filter((id) => id.startsWith('din-'));
    expect(new Set(patterns)).toEqual(new Set([...referencedIds(doc.documentElement)].filter((id) => id.startsWith('din-'))));
    // the page holds all ~100 patterns; the image only what it uses
    expect(patterns.length).toBeLessThan(document.querySelectorAll('[data-din-defs] pattern').length / 4);
  });

  it('drops hover titles, hit areas, the selection outline, classes and ARIA', () => {
    const svg = mount();
    expect(svg.querySelector('[data-export="skip"]')).not.toBeNull();
    const markup = chartMarkup(buildChartSvg(svg, profileExportInfo(borehole(), { t: (s) => s })));
    expect(markup).not.toMatch(/<title|data-export|class=|role=|tabindex|aria-|fill="transparent"|stroke-width="3"/);
    // the live drawing is untouched
    expect(svg.querySelector('[data-export="skip"]')).not.toBeNull();
  });

  it('adds the caption, the depth unit, the legend and the note, with the text escaped', () => {
    const doc = parse(chartMarkup(buildChartSvg(mount(), profileExportInfo(borehole(), { t: (s) => s }))));
    const texts = [...doc.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toContain('BH AB01 & <B> · DIN 4023 profile');
    expect(texts).toContain('m');
    expect(texts).toContain('nach DIN 4023');
    expect(texts.some((t) => t?.startsWith('T ') && t.includes('Clay'))).toBe(true);
    expect(texts.some((t) => t?.startsWith('u ') && t.includes('silt'))).toBe(true);
    expect(doc.documentElement.getAttribute('font-family')).toBeTruthy();
  });

  it('writes the legend in German for the German sheet', () => {
    const doc = parse(chartMarkup(buildChartSvg(mount(), profileExportInfo(borehole(), { t: (s) => (s === 'DIN 4023 profile' ? 'Bohrprofil nach DIN 4023' : s), de: true }))));
    const texts = [...doc.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toContain('BH AB01 & <B> · Bohrprofil nach DIN 4023');
    expect(texts.some((t) => t?.startsWith('T ') && t.includes('Ton'))).toBe(true);
  });

  it('scales the size, not the drawing: width and height × scale, viewBox unchanged', () => {
    const chart = buildChartSvg(mount(), profileExportInfo(borehole(), { t: (s) => s }));
    const root = parse(chartMarkup(chart, PNG_SCALE)).documentElement;
    expect(PNG_SCALE).toBeGreaterThanOrEqual(3);
    expect(Number(root.getAttribute('width'))).toBe(Math.round(chart.width * PNG_SCALE));
    expect(Number(root.getAttribute('height'))).toBe(Math.round(chart.height * PNG_SCALE));
    expect(root.getAttribute('viewBox')).toBe(`0 0 ${chart.width} ${chart.height}`);
  });
});

describe('svgToPng', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draws the SVG at scale × its size on a white canvas and returns a PNG', async () => {
    let src = '';
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        decoding = '';
        set src(v: string) {
          src = v;
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob(['png'], { type })) };
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (tag === 'canvas' ? canvas : create(tag))) as typeof document.createElement);

    const chart = buildChartSvg(mount(), profileExportInfo(borehole(), { t: (s) => s }));
    const png = await svgToPng(chart);
    expect(png.type).toBe('image/png');
    expect([canvas.width, canvas.height]).toEqual([Math.round(chart.width * PNG_SCALE), Math.round(chart.height * PNG_SCALE)]);
    expect(ctx.fillStyle).toBe('#fff');
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, canvas.width, canvas.height);
    const drawn = parse(decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))).documentElement;
    expect(Number(drawn.getAttribute('width'))).toBe(canvas.width);
    vi.unstubAllGlobals();
  });
});

describe('clipboard', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('hands the PNG promise to ClipboardItem as it is (Safari)', async () => {
    const items: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(data: Record<string, unknown>) {
          items.push(data);
        }
      },
    );
    const write = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { write } });
    const png = Promise.resolve(new Blob(['png'], { type: 'image/png' }));
    await copyPng(png);
    expect(write).toHaveBeenCalledTimes(1);
    expect(items[0]['image/png']).toBe(png);
  });

  it('can copy only with ClipboardItem, clipboard.write and a secure origin', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write: async () => undefined } });
    vi.stubGlobal('ClipboardItem', undefined);
    expect(canCopyImage()).toBe(false);
    vi.stubGlobal('ClipboardItem', class {});
    expect(canCopyImage()).toBe(true);
    vi.stubGlobal('isSecureContext', false);
    expect(canCopyImage()).toBe(false);
  });
});
