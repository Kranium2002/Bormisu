/** Server-rendered live-update status line: one text per transport state, announced politely. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveStatus } from './LiveStatus';

describe('LiveStatus', () => {
  it.each([
    ['connecting', 'Connecting to live updates…'],
    ['live', 'Live'],
    ['polling', 'Updating every few seconds'],
    ['offline', 'Offline, retrying'],
  ] as const)('%s says "%s" in a polite live region', (status, text) => {
    const html = renderToStaticMarkup(<LiveStatus status={status} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(new RegExp(`</span>${text}</p>$`));
  });

  it('explains each state in its tooltip', () => {
    expect(renderToStaticMarkup(<LiveStatus status="polling" />)).toContain(
      'title="The live stream is unavailable; documents in progress are checked every few seconds"',
    );
  });
});
