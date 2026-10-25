// Auto layout (`board.layout`, typed as `LayoutApi` in api.ts): the pure layout functions (src/layout/*) applied
// to the elements of a store, with an optional animated transition. Every method takes the ids to arrange
// (default: all) and writes the result to the store in one batch, right away: the animation only changes how
// the cards are drawn.
import { boxOfRect, elementBox, type Aabb } from './interact/geometry';
import {
  align as alignBoxes,
  arrangeGap,
  autoSpot,
  autoSpotArea,
  distribute as distributeBoxes,
  equalWidth as equalWidths,
  masonry as masonryPack,
  placementColumns,
  placementGap,
  planPlacement,
  separate,
  slotWidth,
  tidy as tidyBoxes,
  effectiveAspect,
  type AlignMode,
  type LayoutItem,
} from './layout/index';
import { median } from './layout/stats';
import type { ArrangeOptions, GridOptions, LayoutApi, MasonryOptions } from './api';
import { assertGeometry, idList, oneOf } from './check';
import { clamp } from './math';
import { checkLayoutOptions } from './options';
import type { Stage } from './render/stage';
import type { Store } from './store';
import type { Card, CardId } from './types';

interface Rect4 {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The viewport new cards are placed against while the host has no size.
const NOMINAL_VIEW = { w: 1280, h: 800 };

const ALIGN_MODES: readonly AlignMode[] = ['left', 'centerX', 'right', 'top', 'middleY', 'bottom'];

const ease = (t: number): number => 1 - Math.pow(1 - t, 3);
const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Shown extends Rect4 {
  rot: number;
}

export class BoardLayout implements LayoutApi {
  // The running animation: where each of its cards is drawn now, and the way to end it.
  private animation: { shown: Map<CardId, Shown>; cancel: () => void } | null = null;

  constructor(
    private readonly store: Store,
    private readonly stage: Stage,
    // Throws once the board is disposed (the board's own check; a standalone api never does).
    private readonly alive: () => void = () => {},
  ) {}

  // Ends a running animation at once: the cards show their final rects (already in the store). The board
  // calls this before `load()` swaps its cards.
  cancelAnimation(): void {
    this.animation?.cancel();
    this.animation = null;
  }

  private elementsOf(ids?: readonly CardId[]): Card[] {
    const out: Card[] = [];
    if (ids) {
      for (const id of ids) {
        const el = this.store.get(id);
        if (el) out.push(el);
      }
    } else {
      for (const id of this.store.ids()) out.push(this.store.get(id) as Card);
    }
    return out;
  }

  // Reorders the cards into a masonry grid in reading order (rows top to bottom, left to right). Cards
  // take the median width and keep their aspect; the block stays anchored at its current top-left.
  tidy(ids?: CardId | readonly CardId[], options: GridOptions = {}): void {
    this.alive();
    const list = idList('layout.tidy', ids, true);
    const opts = checkLayoutOptions('layout.tidy', options, 'grid');
    const els = this.elementsOf(list).filter((e) => !e.locked);
    const result = tidyBoxes(
      els.map((e) => ({
        id: e.id,
        box: elementBox(e),
        w: e.w,
        h: e.h,
        free: !e.aspectLocked,
      })),
      { gap: opts.gap, columns: opts.columns },
    );
    const patches = new Map<CardId, Rect4>();
    for (const [id, m] of result.moves) patches.set(id, m);
    this.apply(patches, opts, true);
  }

  // Packs the cards into columns in the order given (the store's draw order by default): each goes into
  // the shortest column. Unlike `tidy` nothing is reordered by position.
  masonry(ids?: CardId | readonly CardId[], options: MasonryOptions = {}): void {
    this.alive();
    const list = idList('layout.masonry', ids, true);
    const opts = checkLayoutOptions('layout.masonry', options, 'masonry');
    const els = this.elementsOf(list).filter((e) => !e.locked);
    if (els.length === 0) return;
    const width = opts.width ?? (median(els.map((e) => e.w)) || 248);
    const gap = opts.gap ?? placementGap(width);
    const items: LayoutItem[] = els.map((e) => ({ aspect: effectiveAspect(e.h / e.w) }));
    let aspectSum = 0;
    for (const it of items) aspectSum += it.aspect;
    const columns = opts.columns ?? placementColumns(els.length, aspectSum / els.length);
    const block = masonryPack(items, { width, gap, columns, slot: slotWidth(items, width) });
    let ax = Infinity;
    let ay = Infinity;
    for (const e of els) {
      const b = elementBox(e);
      ax = Math.min(ax, b.minX);
      ay = Math.min(ay, b.minY);
    }
    const patches = new Map<CardId, Rect4>();
    els.forEach((e, i) => {
      const r = block.rects[i];
      patches.set(e.id, { x: ax + r.x, y: ay + r.y, w: r.w, h: r.h });
    });
    this.apply(patches, opts, true);
  }

  align(mode: AlignMode, ids?: CardId | readonly CardId[], options: ArrangeOptions = {}): void {
    this.alive();
    oneOf('layout.align', 'mode', mode, ALIGN_MODES);
    const list = idList('layout.align', ids, true);
    const opts = checkLayoutOptions('layout.align', options);
    const els = this.elementsOf(list).filter((e) => !e.locked);
    const gap = arrangeGap(els.map((e) => e.w));
    const deltas = alignBoxes(
      els.map((e) => ({ id: e.id, box: elementBox(e) })),
      mode,
      { gap },
    );
    this.applyDeltas(deltas, opts);
  }

  // Equal gaps between the cards along an axis (three or more).
  distribute(axis: 'x' | 'y', ids?: CardId | readonly CardId[], options: ArrangeOptions = {}): void {
    this.alive();
    oneOf('layout.distribute', 'axis', axis, ['x', 'y']);
    const list = idList('layout.distribute', ids, true);
    const opts = checkLayoutOptions('layout.distribute', options);
    const els = this.elementsOf(list).filter((e) => !e.locked);
    const gap = arrangeGap(els.map((e) => e.w));
    const deltas = distributeBoxes(
      els.map((e) => ({ id: e.id, box: elementBox(e) })),
      axis,
      { gap },
    );
    this.applyDeltas(deltas, opts);
  }

  // Every card takes the median width; aspect-locked cards scale their height along. A card that grew
  // pushes its neighbours away (the arrange gap), as with align and distribute.
  equalWidth(ids?: CardId | readonly CardId[], options: ArrangeOptions = {}): void {
    this.alive();
    const list = idList('layout.equalWidth', ids, true);
    const opts = checkLayoutOptions('layout.equalWidth', options);
    const els = this.elementsOf(list).filter((e) => !e.locked);
    const sizes = equalWidths(
      els.map((e) => ({ id: e.id, w: e.w, h: e.h, aspectLocked: e.aspectLocked })),
    );
    if (sizes.size === 0) return;
    const rects = new Map<CardId, Rect4>();
    const items: { id: CardId; box: Aabb }[] = [];
    for (const el of els) {
      const s = sizes.get(el.id);
      // Resized about the centre so the card does not jump.
      const r = s
        ? { x: el.x + (el.w - s.w) / 2, y: el.y + (el.h - s.h) / 2, w: s.w, h: s.h }
        : { x: el.x, y: el.y, w: el.w, h: el.h };
      rects.set(el.id, r);
      items.push({ id: el.id, box: elementBox({ ...r, rot: el.rot }) });
    }
    const patches = new Map<CardId, Rect4>();
    const deltas = separate(items, arrangeGap(els.map((e) => e.w)));
    for (const [id, r] of rects) {
      const d = deltas.get(id);
      if (d || sizes.has(id)) patches.set(id, d ? { ...r, x: r.x + d.dx, y: r.y + d.dy } : r);
    }
    this.apply(patches, opts, false);
  }

  // Gives the elements that have no position a free spot near the middle of what is on screen, laid
  // out as one block. Mutates the given elements (they are not in the store yet). `fixedSize` keeps the
  // size an element came with; `given` keeps the one coordinate (x or y) a card was added with.
  placeNew(
    els: Card[],
    fixedSize: ReadonlySet<CardId>,
    given: ReadonlyMap<CardId, { x?: number; y?: number }> = new Map(),
  ): void {
    this.alive();
    if (els.length === 0) return;
    const widths: number[] = [];
    for (const e of this.store.elements()) widths.push(e.w);
    const items: LayoutItem[] = els.map((e) =>
      fixedSize.has(e.id)
        ? { aspect: effectiveAspect(e.h / e.w), w: e.w, h: e.h }
        : { aspect: effectiveAspect(e.h / e.w) },
    );
    const plan = planPlacement({
      items,
      existingCardWidths: widths,
      anchor: { kind: 'grab', x: 0, y: 0 },
    });
    const block = { w: plan.bounds.maxX - plan.bounds.minX, h: plan.bounds.maxY - plan.bounds.minY };
    const view = this.placementView();
    // Everything the search can reach, not only what is near the viewport.
    const occupied = this.store.searchInto(autoSpotArea(block, view), []).map((e) => elementBox(e));
    const spot = autoSpot(block, view, occupied);
    els.forEach((e, i) => {
      const r = plan.rects[i];
      const g = given.get(e.id);
      e.x = g?.x ?? spot.x + r.x;
      e.y = g?.y ?? spot.y + r.y;
      e.w = r.w;
      e.h = r.h;
    });
  }

  // The viewport placement works against: the camera's, or a nominal one around its centre while the host
  // has no size (the camera then reports a 1 px placeholder, and the search would not leave its spot).
  private placementView(): Aabb {
    const cam = this.stage.cam;
    const v = cam.visibleRect();
    if (!cam.isEmpty && cam.width > 1 && cam.height > 1) {
      return { minX: v.x0, minY: v.y0, maxX: v.x1, maxY: v.y1 };
    }
    const cx = (v.x0 + v.x1) / 2;
    const cy = (v.y0 + v.y1) / 2;
    return {
      minX: cx - NOMINAL_VIEW.w / 2,
      minY: cy - NOMINAL_VIEW.h / 2,
      maxX: cx + NOMINAL_VIEW.w / 2,
      maxY: cy + NOMINAL_VIEW.h / 2,
    };
  }

  // ── Applying ───────────────────────────────────────────────────────────────
  private applyDeltas(
    deltas: Map<CardId, { dx: number; dy: number }>,
    opts: ArrangeOptions,
  ): void {
    const patches = new Map<CardId, Rect4>();
    for (const [id, d] of deltas) {
      const el = this.store.get(id) as Card;
      patches.set(id, { x: el.x + d.dx, y: el.y + d.dy, w: el.w, h: el.h });
    }
    this.apply(patches, opts, false);
  }

  // Writes the patches to the store at once (one batch, the final rects), then animates the cards near the
  // viewport: the stage draws them at preview rects that run from where they were to where they are now.
  // `resetRot`: a grid lays cards out upright.
  private apply(patches: Map<CardId, Rect4>, opts: ArrangeOptions, resetRot: boolean): void {
    // Nothing is written (and no animation is touched) unless every rect is a real one.
    for (const [id, r] of patches) assertGeometry(`layout: card "${id}"`, r);
    // Where the cards of a running animation are drawn now: a new one starts from there.
    const shown = this.animation?.shown;
    this.animation?.cancel();
    this.animation = null;
    if (patches.size === 0) return;
    const animate = (opts.animate ?? true) && !prefersReducedMotion();
    const moving: { id: CardId; from: Shown; to: Rect4; toRot: number }[] = [];
    if (animate) {
      // Only cards that start or end near the viewport are animated; the rest jump (a preview forces a
      // view to be mounted, and a thousand of them would be the cost the culling exists to avoid).
      const v = this.stage.cam.visibleRect();
      const gx = (v.x1 - v.x0) * 0.2;
      const gy = (v.y1 - v.y0) * 0.2;
      const near: Aabb = { minX: v.x0 - gx, minY: v.y0 - gy, maxX: v.x1 + gx, maxY: v.y1 + gy };
      const hits = (b: Aabb): boolean =>
        b.minX <= near.maxX && b.maxX >= near.minX && b.minY <= near.maxY && b.maxY >= near.minY;
      for (const [id, to] of patches) {
        const el = this.store.get(id);
        if (!el) continue;
        const from = shown?.get(id) ?? { x: el.x, y: el.y, w: el.w, h: el.h, rot: el.rot };
        if (hits(boxOfRect(from)) || hits(boxOfRect(to))) {
          moving.push({ id, from, to, toRot: resetRot ? 0 : el.rot });
        }
      }
    }
    this.store.batch(() => {
      for (const [id, r] of patches) this.store.update(id, resetRot ? { ...r, rot: 0 } : r);
    });
    if (moving.length === 0) return;
    const duration = opts.duration ?? 320;
    const stage = this.stage;
    const start = performance.now();
    const current = new Map<CardId, Shown>();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      off();
      // The store holds the final rects already: dropping the previews shows them.
      for (const m of moving) {
        stage.clearPreview(m.id);
        stage.pin(m.id, false);
      }
      if (this.animation?.cancel === finish) this.animation = null;
    };
    const draw = (e: number): void => {
      for (const m of moving) {
        // A card removed mid-animation is gone from the stage too: no preview to leave behind.
        if (!this.store.has(m.id)) continue;
        const r = {
          x: m.from.x + (m.to.x - m.from.x) * e,
          y: m.from.y + (m.to.y - m.from.y) * e,
          w: m.from.w + (m.to.w - m.from.w) * e,
          h: m.from.h + (m.to.h - m.from.h) * e,
          rot: m.from.rot + (m.toRot - m.from.rot) * e,
        };
        current.set(m.id, r);
        stage.setPreview(m.id, r.x, r.y, r.w, r.h, r.rot);
      }
    };
    const off = stage.onBeforeFrame(() => {
      if (done) return;
      const t = clamp((performance.now() - start) / duration, 0, 1);
      draw(ease(t));
      if (t >= 1) finish();
      else stage.requestFrame();
    });
    for (const m of moving) stage.pin(m.id, true);
    // The first frame is the old arrangement: the final rects are in the store already.
    draw(0);
    this.animation = { shown: current, cancel: finish };
    stage.requestFrame();
  }
}
