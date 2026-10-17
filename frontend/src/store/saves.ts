/**
 * Pending review saves per borehole. While saves of a borehole are pending, the store shows the
 * optimistic state; the source's answers (and refetches that arrive meanwhile) are only collected.
 * When the last pending save settles, the newest record collected replaces the borehole, so the
 * server state wins: a failed save rolls back exactly to what the server holds, and a partly saved
 * value shows the part that was saved.
 *
 * "Newest" is the higher revision; at equal revisions, the later observation (a save's call order,
 * a refetch's arrival). An older answer never replaces a newer one.
 */
import type { Borehole } from '../domain/types';

interface Observed { record: Borehole; order: number }
interface Pending { count: number; newest: Observed }

const newer = (a: Observed, b: Observed) =>
  a.record.revision > b.record.revision || (a.record.revision === b.record.revision && a.order > b.order);

export class SaveTracker {
  private readonly pending = new Map<string, Pending>();
  private order = 0;

  /**
   * Starts a save of a borehole and returns its order. `current` is the borehole as shown before
   * this save's optimistic change: for the first pending save, that is what the server holds.
   */
  begin(current: Borehole): number {
    const order = ++this.order;
    const p = this.pending.get(current.uid);
    if (p) p.count += 1;
    else this.pending.set(current.uid, { count: 1, newest: { record: current, order: 0 } });
    return order;
  }

  /** True while a save of this borehole is pending. */
  isPending(uid: string): boolean {
    return this.pending.has(uid);
  }

  /**
   * Collects a record the source reported for a borehole with pending saves (a save's answer, a
   * SaveError's `current`, or a refetch). `order` is the save's order, or nextOrder() for a refetch.
   */
  observe(record: Borehole, order: number): void {
    const p = this.pending.get(record.uid);
    if (!p) return;
    const seen = { record, order };
    if (newer(seen, p.newest)) p.newest = seen;
  }

  /** An order after every save started so far (for records that arrive outside a save). */
  nextOrder(): number {
    return ++this.order;
  }

  /** Ends one save; returns the record to show when it was the last pending save of the borehole. */
  end(uid: string): Borehole | null {
    const p = this.pending.get(uid);
    if (!p) return null;
    p.count -= 1;
    if (p.count > 0) return null;
    this.pending.delete(uid);
    return p.newest.record;
  }
}
