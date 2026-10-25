// The in-memory element store: an id -> element map, an rbush spatial index over the world AABBs, the
// draw order, and change events. This is everything the renderer and the interaction layer read.
//
// Elements are plain objects owned by the store; callers never mutate them, they go through `update`.
// Changes are batched by `batch(fn)`: listeners get one `ChangeSet` per batch.
import RBush from 'rbush';
import type { Aabb } from '../interact/geometry';
import { elementBox } from '../interact/geometry';
import { assertGeometry } from '../check';
import { CorkboardError } from '../errors';
import { reportListenerError } from '../events';
import type {
  Change,
  ChangeSource,
  Card,
  CardId,
  CardPatch,
  CardProp,
  CardUpdate,
  OrderMove,
} from '../types';
import { orderMoves, placeMoves } from './order';

export type { ChangeSource };

/**
 * What changed in one store batch, as a net diff per card id: `added`, `removed` and `updated` never share an id.
 * Cards are the store's own objects: do not mutate them. This is the public {@link Change} plus `reload`.
 */
export interface ChangeSet extends Change {
  source: ChangeSource;
  added: Card[];
  removed: Card[];
  // The element after the change, before it, and the names of the fields that changed.
  updated: CardUpdate[];
  // `loadSnapshot` ran in this batch: the stage rebuilds from the store instead of walking the diff.
  reload?: boolean;
}

/** An event of the store: `change` (a {@link ChangeSet}) or one of its others. */
export type StoreEvent = { type: 'change'; change: ChangeSet };

interface Entry extends Aabb {
  el: Card;
}

const GEOMETRY: readonly string[] = ['x', 'y', 'w', 'h', 'rot'];
// The fields `update` can change, and the ones a change set compares (everything but the id).
const PATCHABLE = [
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
] as const;

/** The cards of a board: id lookup, draw order, a spatial index, change events and batches. The board owns one; reach it with `getInternals`. */
export class Store {
  private readonly map = new Map<CardId, Card>();
  private readonly tree = new RBush<Entry>();
  private readonly entries = new Map<CardId, Entry>();
  // Draw order, bottom first, and each id's index in it (rebuilt lazily after a removal or a reorder).
  // A removal does not shrink `_order` at once (that would cost O(board) per call): it records the id in `dead`,
  // and the next read of `order` drops them all in one pass.
  private _order: CardId[] = [];
  private readonly dead = new Set<CardId>();
  private ranks = new Map<CardId, number>();
  private ranksDirty = false;
  // Bumped when existing ranks change (not on a plain append): the stage then re-sorts its views.
  orderVersion = 0;

  private readonly listeners = new Set<(e: StoreEvent) => void>();
  private depth = 0;
  // The batch in progress. Writes are applied at once; what is reported is computed when the outermost batch
  // ends, from the state the batch started in (`touched`) and the state it ends in: a net diff per id.
  //   touched   id -> the card as it was before the batch's first write to it (undefined: it was not there)
  //   batchSource / source / sawLoad   see `note`
  //   orderLen0 / orderPrev   the draw order before the batch: appends only grow the tail, so the first
  //             `orderLen0` ids are the old order until the first write that is not an append copies them
  private touched = new Map<CardId, Card | undefined>();
  private batchSource: ChangeSource | undefined;
  private source: ChangeSource | undefined;
  private sawLoad = false;
  private reloaded = false;
  private orderLen0 = -1;
  private orderPrev: CardId[] | null = null;
  //   orderHint   the ids given to bringToFront / sendToBack in the batch, while that is all that reordered
  //               (null: nothing yet); orderHintBad: something else reordered, so the moves are computed
  private orderHint: Set<CardId> | null = null;
  private orderHintBad = false;
  // Cards drawn above the rest while a gesture holds them (see `lift`): render and hit order only.
  private liftRank = new Map<CardId, number>();
  // Change sets go to the listeners one at a time, in the order they were made. A write made by a listener
  // while one is being dispatched queues its change set behind the current one: nobody sees it first.
  private dispatching = false;
  private readonly queue: StoreEvent[] = [];

  private get order(): CardId[] {
    if (this.dead.size > 0) this.compact();
    return this._order;
  }

  private set order(v: CardId[]) {
    this._order = v;
    this.dead.clear();
  }

  private compact(): void {
    const dead = this.dead;
    this._order = this._order.filter((i) => !dead.has(i));
    dead.clear();
  }

  get size(): number {
    return this.map.size;
  }

  subscribe(listener: (e: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────
  get(id: CardId): Card | undefined {
    return this.map.get(id);
  }

  has(id: CardId): boolean {
    return this.map.has(id);
  }

  elements(): IterableIterator<Card> {
    return this.map.values();
  }

  // The ids in draw order, bottom first.
  ids(): readonly CardId[] {
    return this.order;
  }

  rank(id: CardId): number {
    const lifted = this.liftRank.get(id);
    if (lifted !== undefined) return lifted;
    if (this.ranksDirty) this.rebuildRanks();
    return this.ranks.get(id) ?? -1;
  }

  // Draws the given cards above all the others (keeping their relative order) until `lift([])`: what a drag does
  // so the card it holds is on top without a write. Only `rank()` (so drawing and hit testing) sees it: the
  // draw order, the snapshot and the change events do not. Replaces the previous lift. Ids not on the board are
  // ignored.
  lift(ids: readonly CardId[]): void {
    const held = ids.filter((id) => this.map.has(id));
    if (held.length === 0 && this.liftRank.size === 0) return;
    held.sort((a, b) => this.baseRank(a) - this.baseRank(b));
    this.liftRank = new Map(held.map((id, i) => [id, this.map.size + i]));
    this.orderVersion++;
  }

  // The held cards stay above every other, in the same relative order: ranks from the current length.
  private relift(): void {
    if (this.liftRank.size === 0) return;
    this.liftRank = new Map([...this.liftRank.keys()].map((id, i) => [id, this.map.size + i]));
    this.orderVersion++;
  }

  private baseRank(id: CardId): number {
    if (this.ranksDirty) this.rebuildRanks();
    return this.ranks.get(id) ?? -1;
  }

  // Elements whose world AABB intersects `box`. `out` is cleared and returned.
  searchInto(box: Aabb, out: Card[]): Card[] {
    out.length = 0;
    const hits = this.tree.search(box);
    for (let i = 0; i < hits.length; i++) out.push(hits[i].el);
    return out;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────
  // `source` is who made the write ('api' when omitted). A `batch` that names a source overrides it.
  add(els: readonly Card[], source?: ChangeSource): void {
    if (els.length === 0) return;
    // All or nothing: a duplicate anywhere in the batch (against the store or inside it) rejects the lot
    // before the first card goes in.
    const ids = new Set<CardId>();
    for (const el of els) {
      if (this.map.has(el.id) || ids.has(el.id)) {
        throw new CorkboardError('invalid', `duplicate element id "${el.id}"`);
      }
      ids.add(el.id);
      // Every write path ends here: a card with a NaN or a zero size never gets in, whoever made it.
      assertGeometry(`add: card "${el.id}"`, el);
    }
    this.batch(() => {
      this.note(source);
      this.markOrder(true);
      for (const el of els) {
        this.touch(el.id);
        this.map.set(el.id, el);
        // An id removed earlier in this batch is still in the order until it is compacted: do that first.
        if (this.dead.has(el.id)) this.compact();
        this._order.push(el.id);
        if (!this.ranksDirty) this.ranks.set(el.id, this._order.length - 1);
        const e = this.entryOf(el);
        this.entries.set(el.id, e);
        this.tree.insert(e);
      }
      // A card added while others are held draws below them.
      this.relift();
    });
  }

  // Applies `patch` to an element. Returns the names of the properties that changed ([] when none). A field
  // left out of the patch, or `undefined`, is kept - except `data`, which an own `undefined` clears.
  update(id: CardId, patch: CardPatch, source?: ChangeSource): CardProp[] {
    const prev = this.map.get(id);
    if (!prev) return [];
    const props: CardProp[] = [];
    const next: Card = { ...prev };
    const rec = patch as Record<string, unknown>;
    for (const k of PATCHABLE) {
      // An own `data: undefined` clears the field; for every other field `undefined` means "leave it".
      if (!(k in rec) || (rec[k] === undefined && k !== 'data')) continue;
      if (Object.is((next as unknown as Record<string, unknown>)[k], rec[k])) continue;
      (next as unknown as Record<string, unknown>)[k] = rec[k];
      props.push(k);
    }
    if (props.length === 0) return props;
    // Layout, gestures, resizes and `applyChange` all write geometry through here: refuse a NaN / Infinity
    // position or a size <= 0 before anything changes.
    if (props.some((p) => GEOMETRY.includes(p))) assertGeometry(`update: card "${id}"`, next);
    this.batch(() => {
      this.note(source);
      this.touch(id);
      this.map.set(id, next);
      if (props.some((p) => GEOMETRY.includes(p))) {
        const old = this.entries.get(id);
        if (old) this.tree.remove(old);
        const e = this.entryOf(next);
        this.entries.set(id, e);
        this.tree.insert(e);
      } else {
        const e = this.entries.get(id);
        if (e) e.el = next;
      }
    });
    return props;
  }

  remove(ids: readonly CardId[], source?: ChangeSource): Card[] {
    const gone: Card[] = [];
    this.batch(() => {
      for (const id of ids) {
        const el = this.map.get(id);
        if (!el) continue;
        if (gone.length === 0) {
          this.note(source);
          this.markOrder(false);
        }
        this.touch(id);
        this.map.delete(id);
        const e = this.entries.get(id);
        if (e) this.tree.remove(e);
        this.entries.delete(id);
        gone.push(el);
      }
      if (gone.length > 0) {
        for (const g of gone) this.dead.add(g.id);
        if (this.liftRank.size > 0) {
          const held = [...this.liftRank.keys()].filter((i) => this.map.has(i));
          this.liftRank = new Map(held.map((id, i) => [id, this.map.size + i]));
        }
        this.ranksDirty = true;
        this.orderVersion++;
      }
    });
    return gone;
  }

  // Moves the ids to the top of the draw order (keeping their relative order). Unknown ids are ignored.
  bringToFront(ids: readonly CardId[], source?: ChangeSource): void {
    const set = new Set(ids.filter((i) => this.map.has(i)));
    if (set.size === 0) return;
    this.reorder(this.order.filter((i) => !set.has(i)).concat(this.order.filter((i) => set.has(i))), source, set);
  }

  // Moves the ids to the bottom of the draw order (keeping their relative order). Unknown ids are ignored.
  sendToBack(ids: readonly CardId[], source?: ChangeSource): void {
    const set = new Set(ids.filter((i) => this.map.has(i)));
    if (set.size === 0) return;
    this.reorder(this.order.filter((i) => set.has(i)).concat(this.order.filter((i) => !set.has(i))), source, set);
  }

  // Sets the draw order. `ids` must be every id on the board exactly once.
  setOrder(ids: readonly CardId[], source?: ChangeSource): void {
    const seen = new Set<CardId>();
    for (const id of ids) {
      if (!this.map.has(id)) throw new CorkboardError('invalid', `setOrder: no card "${id}"`);
      if (seen.has(id)) throw new CorkboardError('invalid', `setOrder: duplicate id "${id}"`);
      seen.add(id);
    }
    if (ids.length !== this.map.size) {
      throw new CorkboardError(
        'invalid',
        `setOrder: expected all ${this.map.size} ids, got ${ids.length}`,
      );
    }
    this.reorder([...ids], source);
  }

  // Replays an `order.moved`: each card goes directly above its `nextBelow` (see `placeMoves`). Entries naming a
  // card that is not here are skipped.
  applyOrderMoves(moves: readonly OrderMove[], source?: ChangeSource): void {
    const next = placeMoves(this.order, moves);
    if (next) this.reorder(next, source);
  }

  // Empties the store.
  clear(source?: ChangeSource): void {
    if (this.map.size === 0) return;
    this.batch(() => {
      this.note(source);
      this.markOrder(false);
      for (const id of this.map.keys()) this.touch(id);
      this.map.clear();
      this.entries.clear();
      this.tree.clear();
      this.order = [];
      this.ranks.clear();
      this.ranksDirty = false;
      this.liftRank.clear();
      this.orderVersion++;
    });
  }

  // Swaps the whole content (`loadSnapshot`) in one step. The change set is the net diff like any other, and
  // carries `reload: true` so the stage rebuilds from the store instead of walking it.
  replaceAll(els: readonly Card[]): void {
    const ids = new Set<CardId>();
    for (const el of els) {
      if (ids.has(el.id)) throw new CorkboardError('invalid', `duplicate element id "${el.id}"`);
      ids.add(el.id);
    }
    this.batch(() => {
      this.reloaded = true;
      this.clear('load');
      this.add(els, 'load');
      // An empty snapshot over an empty board: nothing wrote, so nothing noted 'load'.
      this.note('load');
    }, 'load');
  }

  // Groups every change made inside `fn` into one event. `source` names who made them; with nested batches
  // the outermost one that names a source wins, and 'load' wins over any. If `fn` throws, the event for what
  // it did is still emitted (listeners cannot throw out of it) and `fn`'s error is the one rethrown.
  batch(fn: () => void, source?: ChangeSource): void {
    this.depth++;
    if (source !== undefined && this.batchSource === undefined) this.batchSource = source;
    try {
      fn();
    } finally {
      this.depth--;
      if (this.depth === 0) this.flush();
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────
  private entryOf(el: Card): Entry {
    const b = elementBox(el);
    return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, el };
  }

  // Remembers who wrote: the batch's source if it named one, else the first writer's.
  private note(source: ChangeSource | undefined): void {
    if (source === 'load') this.sawLoad = true;
    this.source ??= this.batchSource ?? source ?? 'api';
  }

  // Remembers a card as it was, before the batch's first write to it. Call it before the write.
  private touch(id: CardId): void {
    if (!this.touched.has(id)) this.touched.set(id, this.map.get(id));
  }

  // Remembers the draw order as it was, before the batch's first write to it. `append`: the write only adds
  // ids at the end (so the old order is still the head of the new one).
  private markOrder(append: boolean, hint?: ReadonlySet<CardId>): void {
    if (this.orderLen0 < 0) this.orderLen0 = this._order.length;
    if (append) return;
    if (this.orderPrev === null) this.orderPrev = this.order.slice(0, this.orderLen0);
    if (hint && !this.orderHintBad) {
      this.orderHint ??= new Set();
      for (const id of hint) this.orderHint.add(id);
    } else {
      this.orderHintBad = true;
    }
  }

  private reorder(next: CardId[], source: ChangeSource | undefined, hint?: ReadonlySet<CardId>): void {
    const cur = this.order;
    if (next.length === cur.length && next.every((id, i) => id === cur[i])) return;
    this.batch(() => {
      this.note(source);
      this.markOrder(false, hint);
      this.order = next;
      this.ranksDirty = true;
      this.orderVersion++;
    });
  }

  private rebuildRanks(): void {
    this.ranks = new Map();
    for (let i = 0; i < this.order.length; i++) this.ranks.set(this.order[i], i);
    this.ranksDirty = false;
  }

  // Turns the batch into one net change set and hands it to the listeners. A listener that throws is
  // reported and skipped: the others, and the state they keep in step with the store, are not affected.
  private flush(): void {
    if (this.dead.size > 0) this.compact();
    const { touched, orderPrev, orderHint, orderHintBad } = this;
    const source = this.sawLoad ? 'load' : (this.source ?? this.batchSource ?? 'api');
    const reload = this.reloaded;
    this.touched = new Map();
    this.batchSource = this.source = undefined;
    this.sawLoad = this.reloaded = false;
    this.orderLen0 = -1;
    this.orderPrev = null;
    this.orderHint = null;
    this.orderHintBad = false;
    if (touched.size === 0 && orderPrev === null) return;

    const added: Card[] = [];
    const removed: Card[] = [];
    const updated: CardUpdate[] = [];
    for (const [id, before] of touched) {
      const after = this.map.get(id);
      if (before === undefined) {
        if (after) added.push(after);
      } else if (!after) {
        removed.push(before);
      } else if (after !== before) {
        const props = PATCHABLE.filter((k) => !Object.is(before[k], after[k]));
        if (props.length > 0) updated.push({ el: after, prev: before, props });
      }
    }
    const c: ChangeSet = { source, added, removed, updated };
    if (orderPrev !== null) {
      // Given ids are enough when the batch only brought cards to the front / sent them back; anything else
      // (an add, a removal, a setOrder) needs the minimal set.
      const hint = !orderHintBad && added.length === 0 && removed.length === 0 ? orderHint : null;
      const moved = orderMoves(orderPrev, this.order, added.map((el) => el.id), hint);
      if (moved) c.order = { moved };
    }
    if (added.length === 0 && removed.length === 0 && updated.length === 0 && !c.order) return;
    if (reload) c.reload = true;
    this.queue.push({ type: 'change', change: c });
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (let i = 0; i < this.queue.length; i++) {
        const e = this.queue[i];
        for (const l of [...this.listeners]) {
          try {
            l(e);
          } catch (err) {
            reportListenerError('change listener', err);
          }
        }
      }
    } finally {
      this.queue.length = 0;
      this.dispatching = false;
    }
  }
}
