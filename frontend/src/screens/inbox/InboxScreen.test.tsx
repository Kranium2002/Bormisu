/** F12: the inbox, server-rendered (fictional questions only). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DOC, DOC_B, makeClarification, UID, UID_B } from '../../components/clarify/clarifyFixtures';
import { groupByDocument } from '../../components/clarify/clarifyModel';
import type { Clarification } from '../../domain/types';
import type { ClarificationsSlice } from '../../store/types';
import { INBOX_EMPTY, INBOX_NOT_OPEN, InboxView } from './InboxScreen';

const DOCS = [
  { id: DOC, name: 'fictional-report.pdf' },
  { id: DOC_B, name: 'fictional-wharf.pdf' },
];
const KNOWN = [{ uid: UID, id: 'BH-1' }];

function render(list: Clarification[], state: ClarificationsSlice['clarificationsState'] = 'ready', notOpen = false) {
  return renderToStaticMarkup(
    <InboxView state={state} groups={groupByDocument(list, DOCS)} known={KNOWN} notOpen={notOpen} onOpen={() => undefined} onRetry={() => undefined} />,
  );
}

describe('InboxView', () => {
  const crs = makeClarification({ id: 'cl_crs', kind: 'crs_confirm', documentId: DOC_B, question: 'Which coordinate system does the fictional wharf use?', boreholeUids: [UID_B] });
  const unit = makeClarification({ id: 'cl_unit', kind: 'unit_ambiguous', documentId: DOC, question: 'Which unit is the fictional value in?' });
  const skipped = makeClarification({ id: 'cl_pages', kind: 'borehole_boundary', documentId: DOC, status: 'skipped', question: 'Which pages belong to BH-1?' });

  it('groups the questions by document, each a button with its kind, text, boreholes and time', () => {
    const html = render([unit, crs, skipped]);
    expect(html.match(/<h2[^>]*>[^<]+<\/h2>/g)).toEqual([
      expect.stringContaining('fictional-report.pdf'),
      expect.stringContaining('fictional-wharf.pdf'),
    ]);
    expect(html).toContain('2 questions');
    const buttons = html.match(/<button[^>]*data-clarification-id="[^"]+"[^>]*>/g) ?? [];
    expect(buttons.map((b) => /data-clarification-id="([^"]+)"/.exec(b)?.[1])).toEqual(['cl_unit', 'cl_pages', 'cl_crs']);
    expect(html).toContain('>UNIT</span>');
    expect(html).toContain('>COORDINATE SYSTEM</span>');
    expect(html).toContain('Which coordinate system does the fictional wharf use?');
    expect(html).toContain('Boreholes: BH-1');
    // A borehole the app has not loaded shows its uid.
    expect(html).toContain(`Boreholes: ${UID_B}`);
    expect(html).toContain('<time dateTime="2026-10-17T07:33:15Z">');
  });

  it('a skipped question says so and stays listed', () => {
    const html = render([skipped]);
    expect(html).toContain('>SKIPPED</span>');
    expect(html).toContain('Which pages belong to BH-1?');
  });

  it('announces the count politely', () => {
    expect(render([unit, crs, skipped])).toMatch(/aria-live="polite" aria-atomic="true">3 unresolved questions</);
    expect(render([unit])).toMatch(/aria-live="polite" aria-atomic="true">1 unresolved question</);
  });

  it('empty, loading and error states', () => {
    expect(render([])).toContain(INBOX_EMPTY);
    expect(render([], 'loading')).toContain('Loading questions…');
    expect(render([], 'idle')).toContain('Loading questions…');
    const error = render([], 'error');
    expect(error).toContain('role="alert"');
    expect(error).toContain('The questions could not be loaded.');
    expect(error).toContain('>RETRY</button>');
    expect(error).not.toContain(INBOX_EMPTY);
  });

  it('a link to a question that is not open says so', () => {
    expect(render([unit], 'ready', true)).toContain(INBOX_NOT_OPEN);
    expect(render([unit], 'ready', false)).not.toContain(INBOX_NOT_OPEN);
  });
});
