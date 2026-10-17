/** FE-EMPTY-1: the map before anything is uploaded (server-rendered); LIST's empty text is in ListTable.test. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyMapOverlay } from './EmptyMapOverlay';

const noop = () => undefined;

describe('FE-EMPTY-1: an empty start', () => {
  it('the map says to upload a report, with a button to the queue', () => {
    const html = renderToStaticMarkup(<EmptyMapOverlay onOpenQueue={noop} />);
    expect(html).toContain('Upload a report to see boreholes here');
    expect(html).toMatch(/<button[^>]*>OPEN UPLOAD &amp; QUEUE<\/button>/);
  });
});
