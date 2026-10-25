// The draw order as anchors: how a `Change` describes a reorder (`orderMoves`) and how `applyChange` replays
// one (`placeMoves`). Pure functions over id lists.
import type { CardId, OrderMove } from '../types';

// Marks the members of one longest strictly increasing subsequence of `seq` (distinct numbers), O(n log n).
function lisMask(seq: readonly number[]): Uint8Array {
  const n = seq.length;
  const mask = new Uint8Array(n);
  const tails: number[] = []; // tails[k]: index in seq of the smallest tail of an increasing run of length k + 1
  const parent = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) parent[i] = tails[lo - 1];
    tails[lo] = i;
  }
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = parent[k]) mask[k] = 1;
  return mask;
}

/**
 * The `order.moved` of a change: the cards to take out and put back to turn `prev` into `next`.
 *
 * `added` are the new cards in the order a replay appends them (they sit on top of the survivors, in this
 * order, before the moves are applied). Without `hint` the moved set is every survivor outside the longest
 * increasing subsequence of old ranks taken in the new order (a card is not moved if it kept its place among
 * the others), every added card that is not where an append puts it, and every removed card. With `hint` (the
 * ids of a `bringToFront` / `sendToBack`; valid only when nothing was added or removed) it is just those.
 * `undefined`: nothing to replay (the order is unchanged, or only grew by the appended cards).
 */
export function orderMoves(
  prev: readonly CardId[],
  next: readonly CardId[],
  added: readonly CardId[],
  hint: ReadonlySet<CardId> | null,
): OrderMove[] | undefined {
  const np = prev.length;
  // Unchanged, or a pure append of the added cards in their replay order.
  if (next.length === np + added.length) {
    let same = true;
    for (let i = 0; same && i < np; i++) same = next[i] === prev[i];
    for (let i = 0; same && i < added.length; i++) same = next[np + i] === added[i];
    if (same) return undefined;
  }
  const prevIdx = new Map<CardId, number>();
  for (let i = 0; i < np; i++) prevIdx.set(prev[i], i);
  const nextSet = new Set(next);
  const out: OrderMove[] = [];
  const below = (list: readonly CardId[], i: number): CardId | null => (i > 0 ? list[i - 1] : null);

  let skip: Uint8Array | null = null;
  if (hint === null) {
    const addedIdx = new Map<CardId, number>();
    added.forEach((id, i) => addedIdx.set(id, i));
    const seq = new Array<number>(next.length);
    for (let i = 0; i < next.length; i++) {
      const id = next[i];
      seq[i] = prevIdx.get(id) ?? np + (addedIdx.get(id) ?? added.length);
    }
    skip = lisMask(seq);
  }
  for (let i = 0; i < next.length; i++) {
    const id = next[i];
    if (skip ? skip[i] === 1 : !hint?.has(id)) continue;
    const pi = prevIdx.get(id);
    out.push({ id, prevBelow: pi === undefined ? null : below(prev, pi), nextBelow: below(next, i) });
  }
  for (let i = 0; i < np; i++) {
    if (!nextSet.has(prev[i])) out.push({ id: prev[i], prevBelow: below(prev, i), nextBelow: null });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Applies `moves` to the order `cur`: each card is placed directly above its `nextBelow` (`null`: at the
 * bottom), bottom of the result first. An entry whose card or anchor is not in `cur` is skipped (the card keeps
 * its place). Returns the new order, or `undefined` when nothing moves (or the anchors are malformed: a cycle).
 */
export function placeMoves(cur: readonly CardId[], moves: readonly OrderMove[]): CardId[] | undefined {
  const present = new Set(cur);
  // The last entry of a card wins; an entry anchored to a card that is absent, or to itself, is skipped.
  const byId = new Map<CardId, OrderMove>();
  for (const m of moves) {
    if (!present.has(m.id)) continue;
    if (m.nextBelow !== null && (m.nextBelow === m.id || !present.has(m.nextBelow))) continue;
    byId.set(m.id, m);
  }
  if (byId.size === 0) return undefined;
  const above = new Map<CardId | null, CardId[]>();
  for (const m of byId.values()) {
    const list = above.get(m.nextBelow);
    if (list) list.push(m.id);
    else above.set(m.nextBelow, [m.id]);
  }
  const out: CardId[] = [];
  // Emits what is placed directly above `anchor`, and what is placed above those, without recursion.
  const emitAbove = (anchor: CardId | null): void => {
    const stack = (above.get(anchor) ?? []).slice().reverse();
    while (stack.length > 0) {
      const id = stack.pop() as CardId;
      out.push(id);
      const kids = above.get(id);
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  };
  emitAbove(null);
  for (const id of cur) {
    if (byId.has(id)) continue;
    out.push(id);
    emitAbove(id);
  }
  if (out.length !== cur.length) return undefined;
  for (let i = 0; i < out.length; i++) if (out[i] !== cur[i]) return out;
  return undefined;
}
