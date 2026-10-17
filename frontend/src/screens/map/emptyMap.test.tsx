/** FE-EMPTY-1: the map and its NOT ON MAP aside before anything is uploaded (server-rendered, fictional data). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeBorehole } from '../../test/fixtures';
import { EmptyMapOverlay } from './EmptyMapOverlay';
import { NotOnMapList } from './NotOnMapList';

const noop = () => undefined;
const EVERY_PLACED = 'Every borehole has usable coordinates and is placed on the map.';

describe('FE-EMPTY-1: an empty start', () => {
  it('the map says to upload a report, with a button to the queue', () => {
    const html = renderToStaticMarkup(<EmptyMapOverlay onOpenQueue={noop} />);
    expect(html).toContain('Upload a report to see boreholes here');
    expect(html).toMatch(/<button[^>]*>OPEN UPLOAD &amp; QUEUE<\/button>/);
  });

  it('NOT ON MAP says there are no boreholes yet instead of claiming every one is placed', () => {
    const html = renderToStaticMarkup(<NotOnMapList boreholes={[]} total={0} onOpen={noop} />);
    expect(html).toContain('NOT ON MAP (0)');
    expect(html).toContain('No boreholes yet.');
    expect(html).not.toContain(EVERY_PLACED);
  });

  it('NOT ON MAP keeps its texts once there are boreholes', () => {
    expect(renderToStaticMarkup(<NotOnMapList boreholes={[]} total={3} onOpen={noop} />)).toContain(EVERY_PLACED);
    const off = makeBorehole({ onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' });
    const html = renderToStaticMarkup(<NotOnMapList boreholes={[off]} total={3} onOpen={noop} />);
    expect(html).toContain('No usable coordinates, so these are listed instead of placed on the map.');
    expect(html).toContain('No coordinates in source');
  });
});
