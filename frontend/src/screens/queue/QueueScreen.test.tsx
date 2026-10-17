/**
 * Server-rendered queue screen (fictional data): the empty start and the page-type legend. Server
 * rendering reads the store's initial state, which holds no documents.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueueScreen } from './QueueScreen';

describe('QueueScreen', () => {
  it('FE-EMPTY-1: says so when there are no documents yet', () => {
    const html = renderToStaticMarkup(<QueueScreen />);
    expect(html).toContain('No documents yet. Drop a report above to extract its boreholes.');
  });

  it('FE-QUEUE-1: the legend tells a classified page of unknown type from a page not classified yet', () => {
    const html = renderToStaticMarkup(<QueueScreen />);
    expect(html).toContain('type unknown');
    expect(html).toContain('not classified yet');
  });
});
