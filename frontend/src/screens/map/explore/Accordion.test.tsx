/** Explore panel accordion: heading buttons with aria-expanded / aria-controls, and the open state kept per viewer (guarded storage). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccordionSection, DEFAULT_SECTIONS, readSections, SECTIONS_KEY, writeSections } from './Accordion';

/** A Map-backed storage. */
function memory(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}
const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('AccordionSection', () => {
  it('a heading with a button that says whether the body is open and which element it controls', () => {
    const open = renderToStaticMarkup(
      <AccordionSection id="place" title="PLACE SEARCH" open onToggle={() => undefined}>
        <p>body</p>
      </AccordionSection>,
    );
    expect(open).toMatch(/<section[^>]*aria-labelledby="explore-place-head"/);
    expect(open).toMatch(/<h2[^>]*><button id="explore-place-head" type="button"[^>]*aria-expanded="true" aria-controls="explore-place-body">PLACE SEARCH<\/button><\/h2>/);
    expect(open).toMatch(/<div id="explore-place-body"[^>]*><p>body<\/p><\/div>/);
    const closed = renderToStaticMarkup(
      <AccordionSection id="filters" title="FILTERS" open={false} onToggle={() => undefined}>
        <p>body</p>
      </AccordionSection>,
    );
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toMatch(/<div id="explore-filters-body"[^>]*hidden=""/);
  });
});

describe('remembered open state', () => {
  it('both sections open by default, and when nothing (or junk) is stored', () => {
    expect(DEFAULT_SECTIONS).toEqual({ place: true, filters: true });
    expect(readSections(memory())).toEqual(DEFAULT_SECTIONS);
    expect(readSections(memory({ [SECTIONS_KEY]: 'not json' }))).toEqual(DEFAULT_SECTIONS);
    expect(readSections(memory({ [SECTIONS_KEY]: '{"place":"no","filters":false}' }))).toEqual({ place: true, filters: false });
    expect(readSections(null)).toEqual(DEFAULT_SECTIONS);
  });

  it('writes and reads back; blocked storage is ignored', () => {
    const s = memory();
    writeSections({ place: false, filters: true }, s);
    expect(readSections(s)).toEqual({ place: false, filters: true });
    expect(() => writeSections({ place: true, filters: true }, throwing)).not.toThrow();
    expect(readSections(throwing)).toEqual(DEFAULT_SECTIONS);
  });
});
