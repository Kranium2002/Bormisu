/**
 * The planned line's EXPORT REPORT, server-rendered with a shown line (fictional values). It is a link
 * among buttons, so it has a class of its own that undoes the link underline and centres its text
 * (PlannedLinePanel.module.css .reportLink); sample mode has no planned lines for the e2e suite.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../../../components/clarify/testStore';
import type { Alignment, AlignmentResult } from '../../../domain/types';
import { PlannedLinePanel } from './PlannedLinePanel';

vi.mock('../../../store/appStore', async (importOriginal) => (await import('../../../components/clarify/testStore')).mockAppStore(await importOriginal()));

const LINE: Alignment = {
  id: 'aln_TEST',
  name: 'Trasse Test (fictional)',
  fileName: 'line.geojson',
  format: 'geojson',
  sourceCrs: 'EPSG:4326',
  parts: [
    [
      [9.4, 50.2],
      [9.42, 50.21],
    ],
  ],
  lengthM: 1800,
  vertexCount: 2,
  partCount: 1,
  bbox: [9.4, 50.2, 9.42, 50.21],
  bufferM: 100,
  createdAt: '2026-10-18T08:00:00Z',
};

const RESULT: AlignmentResult = {
  alignmentId: LINE.id,
  bufferM: 150,
  includeUnreviewed: true,
  lengthM: 1800,
  metricCrs: 'EPSG:32632',
  band: [],
  hits: [],
  excludedUnreviewed: 0,
  notOnMap: 0,
  resultSet: {
    id: 'rs_TEST',
    count: 0,
    locatedCount: 0,
    unlocatedCount: 0,
    excludedUnreviewed: null,
    uids: [],
    bbox: null,
    area: null,
    definition: {
      search: null,
      country: null,
      project: null,
      documentId: null,
      minDepth: null,
      maxDepth: null,
      dinCodes: [],
      lithologyMinDepth: null,
      hasSpt: null,
      hasGroundwater: null,
      reviewStatus: [],
      includeUnreviewed: true,
      area: null,
    },
    createdAt: '2026-10-18T08:00:00Z',
  },
};

describe('planned line: EXPORT REPORT', () => {
  beforeEach(() => resetTestStore({ alignment: LINE, alignmentResult: RESULT }));

  it('links to the line report with its distance and scope, styled as a button, not an underlined link', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PlannedLinePanel open onClose={() => undefined} />
      </MemoryRouter>,
    );
    const link = /<a [^>]*data-testid="export-report"[^>]*>EXPORT REPORT<\/a>/.exec(html)?.[0] ?? '';
    expect(link).toContain('href="/report?rs=rs_TEST&amp;line=aln_TEST&amp;buffer=150&amp;unrev=1"');
    const linkClass = /class="([^"]*)"/.exec(link)?.[1];
    const clearClass = /<button type="button" class="([^"]*)">CLEAR<\/button>/.exec(html)?.[1];
    expect(linkClass).toContain('reportLink');
    // Not the buttons' class as it was: on a link that one leaves the underline and the text at the top.
    expect(clearClass).toBeTruthy();
    expect(linkClass).not.toBe(clearClass);
  });
});
