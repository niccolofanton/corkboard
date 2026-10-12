import { describe, expect, it } from 'vitest';
import { planEviction, type LruEntry } from '../../src/render/lru';

const MB = 1024 * 1024;
const entry = (id: number, last: number, bytes = MB, pinned = false): LruEntry => ({
  id,
  last,
  bytes,
  pinned,
});

describe('planEviction', () => {
  it('does nothing while under budget', () => {
    expect(planEviction([entry(1, 1), entry(2, 2)], 100 * MB, 256 * MB)).toEqual([]);
  });

  it('evicts least recently used first, down to 85 % of the budget', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(i, 100 - i)); // id 19 is the oldest
    // Total 110 MB against a 100 MB budget: the goal is 85 MB, so 25 MB must go but only 20 exist.
    const out = planEviction(entries, 110 * MB, 100 * MB);
    expect(out[0]).toBe(19);
    expect(out).toHaveLength(20);
    // Total 100.5 MB: 15.5 MB over the 85 MB goal -> 16 entries of 1 MB.
    expect(planEviction(entries, 100.5 * MB, 100 * MB)).toHaveLength(16);
  });

  it('never evicts what is on screen, even over budget', () => {
    const entries = [entry(1, 1, 50 * MB, true), entry(2, 2, 50 * MB, true), entry(3, 3, 10 * MB)];
    expect(planEviction(entries, 110 * MB, 100 * MB)).toEqual([3]);
  });

  it('keeps the total under budget over a long pan (a simulated LRU)', () => {
    const budget = 256 * MB;
    const resident = new Map<number, LruEntry>();
    let total = 0;
    let peak = 0;
    for (let i = 0; i < 3000; i++) {
      // One new 1.1 MB texture per step; the last 40 are "on screen".
      const e = entry(i, i, 1.1 * MB);
      resident.set(i, e);
      total += e.bytes;
      for (const r of resident.values()) r.pinned = r.id > i - 40;
      for (const id of planEviction([...resident.values()], total, budget)) {
        total -= (resident.get(id) as LruEntry).bytes;
        resident.delete(id);
      }
      peak = Math.max(peak, total);
    }
    expect(peak).toBeLessThanOrEqual(budget + 1.1 * MB);
    expect(resident.size).toBeGreaterThan(150);
  });
});
