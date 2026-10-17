import { describe, expect, it } from 'vitest';
import { makeBorehole } from '../test/fixtures';
import { SaveTracker } from './saves';

const at = (revision: number, id = 'TB-01') => makeBorehole({ revision, id });

describe('SaveTracker', () => {
  it('shows nothing until the last pending save of a borehole ends, then the newest record', () => {
    const t = new SaveTracker();
    const a = t.begin(at(1));
    const b = t.begin(at(1));
    expect(t.isPending(at(1).uid)).toBe(true);
    t.observe(at(2, 'after A'), a);
    expect(t.end(at(1).uid)).toBeNull();
    t.observe(at(3, 'after B'), b);
    expect(t.end(at(1).uid)?.id).toBe('after B');
    expect(t.isPending(at(1).uid)).toBe(false);
  });

  it('keeps the higher revision, whatever the order the answers arrive in', () => {
    const t = new SaveTracker();
    const a = t.begin(at(1));
    const b = t.begin(at(1));
    t.observe(at(3, 'B'), b);
    t.observe(at(2, 'A'), a);
    t.end(at(1).uid);
    expect(t.end(at(1).uid)?.id).toBe('B');
  });

  it('at equal revisions the later save wins; with no answer at all the server state from before stays', () => {
    const t = new SaveTracker();
    const a = t.begin(at(1, 'before'));
    const b = t.begin(at(1, 'optimistic'));
    t.observe(at(1, 'B'), b);
    t.observe(at(1, 'A'), a);
    t.end(at(1).uid);
    expect(t.end(at(1).uid)?.id).toBe('B');
    t.begin(at(4, 'server'));
    expect(t.end(at(1).uid)?.id).toBe('server');
  });

  it('ignores records of boreholes without pending saves', () => {
    const t = new SaveTracker();
    t.observe(at(9), t.nextOrder());
    expect(t.end(at(9).uid)).toBeNull();
  });
});
