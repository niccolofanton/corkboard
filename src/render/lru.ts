// Texture eviction policy (pure, so it can be unit tested without a GL context).
//
// Texture memory follows what is on screen, not the board size: when the total goes over `budget`,
// unpinned entries (not on screen) are evicted least recently used first, down to `target * budget`
// so the next upload does not immediately trigger another pass.
export interface LruEntry {
  id: number;
  // Last time (ms) the entry was on screen.
  last: number;
  bytes: number;
  // On screen right now: never evicted.
  pinned: boolean;
}

export function planEviction(
  entries: readonly LruEntry[],
  total: number,
  budget: number,
  target = 0.85,
): number[] {
  if (total <= budget) return [];
  const goal = budget * target;
  const out: number[] = [];
  const candidates = entries.filter((e) => !e.pinned).sort((a, b) => a.last - b.last);
  let t = total;
  for (const e of candidates) {
    if (t <= goal) break;
    out.push(e.id);
    t -= e.bytes;
  }
  return out;
}
