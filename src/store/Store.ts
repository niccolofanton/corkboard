// The in-memory element store: an id -> element map, an rbush spatial index over the world AABBs, the
// draw order, and change events. This is everything the renderer and the interaction layer read.
//
// Elements are plain objects owned by the store; callers never mutate them, they go through `update`.
// Changes are batched by `batch(fn)`: listeners get one `ChangeSet` per batch.
import RBush from 'rbush';
import type { Box } from '../interact/geometry';
import { elementBox } from '../interact/geometry';
import type { Element, ElementId, ElementPatch } from '../types';

export type ChangeSource = 'load' | 'local';

export interface ChangeSet {
  source: ChangeSource;
  added: Element[];
  removed: Element[];
  // The element after the change and the names of the properties that changed.
  updated: { el: Element; props: string[] }[];
}

export type StoreEvent = { type: 'change'; change: ChangeSet };

interface Entry extends Box {
  el: Element;
}

const GEOMETRY = ['x', 'y', 'w', 'h', 'rot'] as const;
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

export class Store {
  private readonly map = new Map<ElementId, Element>();
  private readonly tree = new RBush<Entry>();
  private readonly entries = new Map<ElementId, Entry>();
  // Draw order, bottom first, and each id's index in it (rebuilt lazily after a removal or a reorder).
  private order: ElementId[] = [];
  private ranks = new Map<ElementId, number>();
  private ranksDirty = false;
  // Bumped when existing ranks change (not on a plain append): the stage then re-sorts its views.
  orderVersion = 0;

  private readonly listeners = new Set<(e: StoreEvent) => void>();
  private pending: ChangeSet | null = null;
  private depth = 0;

  get size(): number {
    return this.map.size;
  }

  subscribe(listener: (e: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────
  get(id: ElementId): Element | undefined {
    return this.map.get(id);
  }

  has(id: ElementId): boolean {
    return this.map.has(id);
  }

  elements(): IterableIterator<Element> {
    return this.map.values();
  }

  // The ids in draw order, bottom first.
  ids(): readonly ElementId[] {
    return this.order;
  }

  rank(id: ElementId): number {
    if (this.ranksDirty) this.rebuildRanks();
    return this.ranks.get(id) ?? -1;
  }

  // Elements whose world AABB intersects `box`. `out` is cleared and returned.
  searchInto(box: Box, out: Element[]): Element[] {
    out.length = 0;
    const hits = this.tree.search(box);
    for (let i = 0; i < hits.length; i++) out.push(hits[i].el);
    return out;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────
  add(els: readonly Element[], source: ChangeSource = 'local'): void {
    if (els.length === 0) return;
    this.batch(() => {
      for (const el of els) {
        if (this.map.has(el.id)) throw new Error(`corkboard: duplicate element id "${el.id}"`);
        this.map.set(el.id, el);
        this.order.push(el.id);
        if (!this.ranksDirty) this.ranks.set(el.id, this.order.length - 1);
        const e = this.entryOf(el);
        this.entries.set(el.id, e);
        this.tree.insert(e);
        this.change(source).added.push(el);
      }
    });
  }

  // Applies `patch` to an element. Returns the names of the properties that changed ([] when none).
  update(id: ElementId, patch: ElementPatch, source: ChangeSource = 'local'): string[] {
    const prev = this.map.get(id);
    if (!prev) return [];
    const props: string[] = [];
    const next: Element = { ...prev };
    const rec = patch as Record<string, unknown>;
    for (const k of PATCHABLE) {
      if (!(k in rec) || rec[k] === undefined) continue;
      if (Object.is((next as unknown as Record<string, unknown>)[k], rec[k])) continue;
      (next as unknown as Record<string, unknown>)[k] = rec[k];
      props.push(k);
    }
    if (props.length === 0) return props;
    this.map.set(id, next);
    if (props.some((p) => (GEOMETRY as readonly string[]).includes(p))) {
      const old = this.entries.get(id);
      if (old) this.tree.remove(old);
      const e = this.entryOf(next);
      this.entries.set(id, e);
      this.tree.insert(e);
    } else {
      const e = this.entries.get(id);
      if (e) e.el = next;
    }
    this.batch(() => {
      const c = this.change(source);
      // A second update of the same element in one batch folds into one entry.
      const at = c.updated.findIndex((u) => u.el.id === id);
      if (at >= 0) {
        const merged = new Set([...c.updated[at].props, ...props]);
        c.updated[at] = { el: next, props: [...merged] };
      } else c.updated.push({ el: next, props });
    });
    return props;
  }

  remove(ids: readonly ElementId[], source: ChangeSource = 'local'): Element[] {
    const gone: Element[] = [];
    this.batch(() => {
      for (const id of ids) {
        const el = this.map.get(id);
        if (!el) continue;
        this.map.delete(id);
        const e = this.entries.get(id);
        if (e) this.tree.remove(e);
        this.entries.delete(id);
        gone.push(el);
        this.change(source).removed.push(el);
      }
      if (gone.length > 0) {
        const dead = new Set(gone.map((g) => g.id));
        this.order = this.order.filter((i) => !dead.has(i));
        this.ranksDirty = true;
        this.orderVersion++;
      }
    });
    return gone;
  }

  // Moves the ids to the top of the draw order (keeping their relative order).
  bringToFront(ids: readonly ElementId[]): void {
    const set = new Set(ids.filter((i) => this.map.has(i)));
    if (set.size === 0) return;
    const keep = this.order.filter((i) => !set.has(i));
    const lifted = this.order.filter((i) => set.has(i));
    this.order = keep.concat(lifted);
    this.ranksDirty = true;
    this.orderVersion++;
    this.batch(() => {
      for (const id of lifted) {
        const el = this.map.get(id) as Element;
        this.change('local').updated.push({ el, props: ['order'] });
      }
    });
  }

  // Replaces everything (the stage reloads from the store at its next tick).
  clear(): void {
    const all = [...this.map.values()];
    this.map.clear();
    this.entries.clear();
    this.tree.clear();
    this.order = [];
    this.ranks.clear();
    this.ranksDirty = false;
    this.orderVersion++;
    if (all.length === 0) return;
    this.batch(() => {
      this.change('local').removed.push(...all);
    });
  }

  // Groups every change made inside `fn` into one event.
  batch(fn: () => void): void {
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
      if (this.depth === 0) this.flush();
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────
  private entryOf(el: Element): Entry {
    const b = elementBox(el);
    return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, el };
  }

  private change(source: ChangeSource): ChangeSet {
    return (this.pending ??= { source, added: [], removed: [], updated: [] });
  }

  private rebuildRanks(): void {
    this.ranks = new Map();
    for (let i = 0; i < this.order.length; i++) this.ranks.set(this.order[i], i);
    this.ranksDirty = false;
  }

  private flush(): void {
    const c = this.pending;
    this.pending = null;
    if (!c || (c.added.length === 0 && c.removed.length === 0 && c.updated.length === 0)) return;
    for (const l of [...this.listeners]) l({ type: 'change', change: c });
  }
}
