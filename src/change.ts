// Replaying and inverting a `Change`: `invertChange` (pure) and `applyChangeTo` (what `board.applyChange` runs on
// the store). See `Corkboard.applyChange` for the contract.
import { deepEqual } from './equal';
import { copyMedia } from './model';
import type { Store } from './store';
import type { Change, ChangeSource, Card, CardPatch, CardProp, CardUpdate } from './types';

/**
 * The change that undoes `c`: `added` and `removed` swap, each `updated` entry swaps `el` and `prev` (its
 * `props` stay), and each `order.moved` entry swaps `prevBelow` and `nextBelow`. `source` is kept. Pure, and an
 * involution: `invertChange(invertChange(c))` deep-equals `c`.
 *
 * Applying the result to a board in the state `c` left it in (`board.applyChange(c, { invert: true })` does
 * both) brings the board back to the state before `c`, draw order included.
 */
export function invertChange(c: Change): Change {
  const out: Change = {
    source: c.source,
    added: [...c.removed],
    removed: [...c.added],
    updated: c.updated.map((u): CardUpdate => ({ el: u.prev, prev: u.el, props: u.props })),
  };
  if (c.order) {
    out.order = {
      moved: c.order.moved.map((m) => ({ id: m.id, prevBelow: m.nextBelow, nextBelow: m.prevBelow })),
    };
  }
  return out;
}

/** Options of `board.applyChange`. */
export interface ApplyChangeOptions {
  /**
   * Apply the inverse of the change (an undo).
   * @default false
   */
  invert?: boolean;
  /**
   * The `source` of the `change` event this produces.
   * @default 'undo' when `invert` is set, else 'apply'
   */
  source?: ChangeSource;
  /**
   * What to do with an `updated` field that is no longer what the change started from (it was edited since):
   * `'skip'` leaves that field alone, `'overwrite'` writes it anyway. Cards that were `removed` and cards that
   * were `added` are not subject to it.
   * @default 'skip' when `invert` is set, else 'overwrite'
   */
  conflict?: 'skip' | 'overwrite';
}

const PROPS: readonly CardProp[] = [
  'x',
  'y',
  'w',
  'h',
  'rot',
  'locked',
  'media',
  'radius',
  'aspectLocked',
  'data',
  'kind',
];

// A whole card as the store keeps it: the change's fields exactly, `media` copied.
function elementOf(src: Card): Card {
  return {
    id: src.id,
    kind: src.kind,
    x: src.x,
    y: src.y,
    w: src.w,
    h: src.h,
    rot: src.rot,
    locked: src.locked,
    media: copyMedia(src.media),
    radius: src.radius,
    aspectLocked: src.aspectLocked,
    data: src.data,
  };
}

/**
 * Replays `c` (inverted if asked) on the store: remove, upsert, update, then the draw order, in ONE batch. The
 * change must be valid (`validateChange`); nothing here throws for anything else: ids that are not there are
 * skipped.
 */
export function applyChangeTo(store: Store, c: Change, opts: ApplyChangeOptions): void {
  const change = opts.invert ? invertChange(c) : c;
  const skip = (opts.conflict ?? (opts.invert ? 'skip' : 'overwrite')) === 'skip';
  const source = opts.source ?? (opts.invert ? 'undo' : 'apply');
  store.batch(() => {
    // (a) removals
    if (change.removed.length > 0) store.remove(change.removed.map((el) => el.id), source);

    // (b) upserts: the card exactly as given. An id already there is overwritten in place, a new one goes on top.
    const added: Card[] = [];
    for (const el of change.added) {
      const next = elementOf(el);
      const cur = store.get(next.id);
      if (!cur) {
        added.push(next);
        continue;
      }
      if (deepEqual(cur.media, next.media)) next.media = cur.media;
      if (deepEqual(cur.data, next.data)) next.data = cur.data;
      store.update(next.id, next as CardPatch, source);
    }
    if (added.length > 0) store.add(added, source);

    // (c) field updates, written as they are (no size is derived from the media)
    for (const u of change.updated) {
      const cur = store.get(u.el.id);
      if (!cur) continue;
      const patch: Record<string, unknown> = {};
      let any = false;
      for (const p of u.props) {
        if (!PROPS.includes(p)) continue;
        if (skip && !deepEqual(cur[p], u.prev[p])) continue;
        const value = p === 'media' ? copyMedia(u.el.media) : u.el[p];
        if (deepEqual(cur[p], value)) continue;
        patch[p] = value;
        any = true;
      }
      if (any) store.update(cur.id, patch as CardPatch, source);
    }

    // (d) the draw order
    if (change.order && change.order.moved.length > 0) store.applyOrderMoves(change.order.moved, source);
  }, source);
}
