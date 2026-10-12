// Auto layout: the pure layout functions (src/layout/*) applied to the elements of a store, with an
// optional animated transition. Every method takes the ids to arrange (default: all) and writes the
// result to the store in one batch.
import { boxOfRect, elementBox, type Box } from './interact/geometry';
import {
  align as alignBoxes,
  arrangeGap,
  autoSpot,
  distribute as distributeBoxes,
  equalWidth as equalWidths,
  masonry as masonryPack,
  placementColumns,
  placementGap,
  planPlacement,
  slotWidth,
  tidy as tidyBoxes,
  effectiveAspect,
  type AlignMode,
  type LayoutItem,
} from './layout/index';
import { median } from './layout/stats';
import { clamp } from './math';
import type { Stage } from './render/stage';
import type { Store } from './store';
import type { Element, ElementId } from './types';

export interface ArrangeOptions {
  // Animate the move (default true; elements far from the viewport jump).
  animate?: boolean;
  // Duration of the animation, ms (default 320).
  duration?: number;
}

export interface GridOptions extends ArrangeOptions {
  // Space between cards, world px (default: a tenth of the card width, 12..48).
  gap?: number;
  // Number of columns (default: a roughly square block, at most 10).
  columns?: number;
}

export interface MasonryOptions extends GridOptions {
  // Width of every card, world px (default: the median width).
  width?: number;
}

interface Rect4 {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ease = (t: number): number => 1 - Math.pow(1 - t, 3);
const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class LayoutApi {
  private animation: { cancel: () => void } | null = null;

  constructor(
    private readonly store: Store,
    private readonly stage: Stage,
  ) {}

  private elementsOf(ids?: readonly ElementId[]): Element[] {
    const out: Element[] = [];
    if (ids) {
      for (const id of ids) {
        const el = this.store.get(id);
        if (el) out.push(el);
      }
    } else {
      for (const id of this.store.ids()) out.push(this.store.get(id) as Element);
    }
    return out;
  }

  // Reorders the cards into a masonry grid in reading order (rows top to bottom, left to right). Cards
  // take the median width and keep their aspect; the block stays anchored at its current top-left.
  tidy(ids?: readonly ElementId[], opts: GridOptions = {}): void {
    const els = this.elementsOf(ids).filter((e) => !e.locked);
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
    const patches = new Map<ElementId, Rect4>();
    for (const [id, m] of result.moves) patches.set(id, m);
    this.apply(patches, opts, true);
  }

  // Packs the cards into columns in the order given (the store's draw order by default): each goes into
  // the shortest column. Unlike `tidy` nothing is reordered by position.
  masonry(ids?: readonly ElementId[], opts: MasonryOptions = {}): void {
    const els = this.elementsOf(ids).filter((e) => !e.locked);
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
    const patches = new Map<ElementId, Rect4>();
    els.forEach((e, i) => {
      const r = block.rects[i];
      patches.set(e.id, { x: ax + r.x, y: ay + r.y, w: r.w, h: r.h });
    });
    this.apply(patches, opts, true);
  }

  align(mode: AlignMode, ids?: readonly ElementId[], opts: ArrangeOptions = {}): void {
    const els = this.elementsOf(ids).filter((e) => !e.locked);
    const gap = arrangeGap(els.map((e) => e.w));
    const deltas = alignBoxes(
      els.map((e) => ({ id: e.id, box: elementBox(e) })),
      mode,
      { gap },
    );
    this.applyDeltas(deltas, opts);
  }

  // Equal gaps between the cards along an axis (three or more).
  distribute(axis: 'x' | 'y', ids?: readonly ElementId[], opts: ArrangeOptions = {}): void {
    const els = this.elementsOf(ids).filter((e) => !e.locked);
    const gap = arrangeGap(els.map((e) => e.w));
    const deltas = distributeBoxes(
      els.map((e) => ({ id: e.id, box: elementBox(e) })),
      axis,
      { gap },
    );
    this.applyDeltas(deltas, opts);
  }

  // Every card takes the median width; aspect-locked cards scale their height along.
  equalWidth(ids?: readonly ElementId[], opts: ArrangeOptions = {}): void {
    const els = this.elementsOf(ids).filter((e) => !e.locked);
    const sizes = equalWidths(
      els.map((e) => ({ id: e.id, w: e.w, h: e.h, aspectLocked: e.aspectLocked })),
    );
    const patches = new Map<ElementId, Rect4>();
    for (const [id, s] of sizes) {
      const el = this.store.get(id) as Element;
      // Resized about the centre so the card does not jump.
      patches.set(id, {
        x: el.x + (el.w - s.w) / 2,
        y: el.y + (el.h - s.h) / 2,
        w: s.w,
        h: s.h,
      });
    }
    this.apply(patches, opts, true);
  }

  // Gives the elements that have no position a free spot near the middle of what is on screen, laid
  // out as one block. Mutates the given elements (they are not in the store yet).
  placeNew(els: Element[], fixedSize: ReadonlySet<ElementId>): void {
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
    const bw = plan.bounds.maxX - plan.bounds.minX;
    const bh = plan.bounds.maxY - plan.bounds.minY;
    const v = this.stage.cam.visibleRect();
    const view: Box = { minX: v.x0, minY: v.y0, maxX: v.x1, maxY: v.y1 };
    const grow: Box = {
      minX: v.x0 - (v.x1 - v.x0) / 2,
      minY: v.y0 - (v.y1 - v.y0) / 2,
      maxX: v.x1 + (v.x1 - v.x0) / 2,
      maxY: v.y1 + (v.y1 - v.y0) / 2,
    };
    const occupied = this.store.searchInto(grow, []).map((e) => elementBox(e));
    const spot = autoSpot({ w: bw, h: bh }, view, occupied);
    els.forEach((e, i) => {
      const r = plan.rects[i];
      e.x = spot.x + r.x;
      e.y = spot.y + r.y;
      e.w = r.w;
      e.h = r.h;
    });
  }

  // ── Applying ───────────────────────────────────────────────────────────────
  private applyDeltas(
    deltas: Map<ElementId, { dx: number; dy: number }>,
    opts: ArrangeOptions,
  ): void {
    const patches = new Map<ElementId, Rect4>();
    for (const [id, d] of deltas) {
      const el = this.store.get(id) as Element;
      patches.set(id, { x: el.x + d.dx, y: el.y + d.dy, w: el.w, h: el.h });
    }
    this.apply(patches, opts, false);
  }

  // Writes the patches to the store, animating the cards near the viewport. `resetRot`: a grid lays
  // cards out upright.
  private apply(patches: Map<ElementId, Rect4>, opts: ArrangeOptions, resetRot: boolean): void {
    this.animation?.cancel();
    this.animation = null;
    if (patches.size === 0) return;
    const animate = (opts.animate ?? true) && !prefersReducedMotion();
    const write = (list: [ElementId, Rect4][]): void => {
      this.store.batch(() => {
        for (const [id, r] of list) {
          this.store.update(id, resetRot ? { ...r, rot: 0 } : r);
        }
      });
    };
    if (!animate) {
      write([...patches]);
      return;
    }
    // Only cards that start or end near the viewport are animated; the rest jump (a preview forces a
    // view to be mounted, and a thousand of them would be the cost the culling exists to avoid).
    const v = this.stage.cam.visibleRect();
    const gx = (v.x1 - v.x0) * 0.2;
    const gy = (v.y1 - v.y0) * 0.2;
    const near: Box = { minX: v.x0 - gx, minY: v.y0 - gy, maxX: v.x1 + gx, maxY: v.y1 + gy };
    const hits = (b: Box): boolean =>
      b.minX <= near.maxX && b.maxX >= near.minX && b.minY <= near.maxY && b.maxY >= near.minY;
    const moving: { id: ElementId; from: Rect4; to: Rect4; rot: number; toRot: number }[] = [];
    const jump: [ElementId, Rect4][] = [];
    for (const [id, to] of patches) {
      const el = this.store.get(id);
      if (!el) continue;
      const from = { x: el.x, y: el.y, w: el.w, h: el.h };
      if (hits(boxOfRect(from)) || hits(boxOfRect(to))) {
        moving.push({ id, from, to, rot: el.rot, toRot: resetRot ? 0 : el.rot });
      } else jump.push([id, to]);
    }
    write(jump);
    if (moving.length === 0) return;
    const duration = opts.duration ?? 320;
    const stage = this.stage;
    const start = performance.now();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      off();
      write(moving.map((m) => [m.id, m.to]));
      for (const m of moving) {
        stage.clearPreview(m.id);
        stage.pin(m.id, false);
      }
      this.animation = null;
    };
    const off = stage.onBeforeFrame(() => {
      if (done) return;
      const t = clamp((performance.now() - start) / duration, 0, 1);
      const e = ease(t);
      for (const m of moving) {
        stage.setPreview(
          m.id,
          m.from.x + (m.to.x - m.from.x) * e,
          m.from.y + (m.to.y - m.from.y) * e,
          m.from.w + (m.to.w - m.from.w) * e,
          m.from.h + (m.to.h - m.from.h) * e,
          m.rot + (m.toRot - m.rot) * e,
        );
      }
      if (t >= 1) finish();
      else stage.requestFrame();
    });
    for (const m of moving) stage.pin(m.id, true);
    this.animation = { cancel: finish };
    stage.requestFrame();
  }
}
