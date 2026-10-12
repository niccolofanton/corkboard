// Align / distribute / equal width. Pure; the results are deltas and sizes the
// caller turns into ops. Everything works on world AABBs (rotation and paint pad included), so
// "aligned" means the visible edges line up.
//
// Lining boxes up is, on its own, what makes a board pile up: align everything to the left and
// every card of a row lands on the same spot. So `align` and `distribute` take a gap
// (`opts.gap`, see `arrangeGap`): with it the edge is still the one asked for, but whatever would end up
// on top of another box (or closer than the gap) slides along the OTHER axis until it is clear. Without
// it they are the plain geometric operations.
import { boxCx, boxCy, boxH, boxW, type Box } from '../interact/geometry';
import { PLACEMENT_FALLBACK_WIDTH } from './masonry';
import { bandOrder } from './order';
import { placementGap } from './placement';
import { median } from './stats';

export type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom';

export interface Delta {
  dx: number;
  dy: number;
}

// Anything below this is floating point noise, not a move.
const EPS = 1e-9;
// Two boxes are clear of each other when the room between them is the gap, give or take this.
const CLEAR_EPS = 1e-6;

export interface ArrangeOpts {
  // The room kept between boxes that would otherwise touch or overlap. Absent: no overlap handling.
  gap?: number;
}

// The gap an arrange keeps between the selected items: the placement gap of their median width (the same
// `placementGap` the grid and the placement of new cards use).
export function arrangeGap(widths: readonly number[]): number {
  const w = median(widths.filter((v) => Number.isFinite(v) && v > 0));
  return placementGap(w > 0 ? w : PLACEMENT_FALLBACK_WIDTH);
}

const shifted = (b: Box, d: Delta | undefined): Box =>
  d === undefined
    ? b
    : { minX: b.minX + d.dx, minY: b.minY + d.dy, maxX: b.maxX + d.dx, maxY: b.maxY + d.dy };

const addDelta = (out: Map<string, Delta>, id: string, d: Delta): void => {
  const prev = out.get(id);
  const dx = (prev?.dx ?? 0) + d.dx;
  const dy = (prev?.dy ?? 0) + d.dy;
  if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) out.set(id, { dx, dy });
  else out.delete(id);
};

// Slides boxes apart until none is on top of another or closer than `gap`: the minimal moves, the first
// of every pile staying where it is. Items are settled one after the other; one that collides with the
// ones already settled goes past them, to the right or down by whichever is shorter (`axis` forces
// one). Only ever right or down, so a box that has cleared another stays clear of it and the loop ends.
//
// Order: the bands of `axis` (a row stays in its left-to-right order, a column in its top-to-bottom
// one), else reading order (rows, then left to right); `inOrder` takes the items as given (the caller
// ordered them on their boxes from before a move). Pure; returns the deltas of the boxes that moved.
export function separate(
  items: readonly { id: string; box: Box }[],
  gap: number,
  axis?: 'x' | 'y',
  inOrder = false,
): Map<string, Delta> {
  const out = new Map<string, Delta>();
  const n = items.length;
  if (n < 2) return out;
  const g = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const order = inOrder ? items : bandOrder(items, axis ?? 'y');
  const placed: Box[] = [];
  for (const it of order) {
    let box = it.box;
    let dx = 0;
    let dy = 0;
    // Every pass clears all the boxes it hit for good: at most one pass per settled box.
    for (let pass = 0; pass <= placed.length; pass++) {
      let farX = -Infinity;
      let farY = -Infinity;
      for (const p of placed) {
        if (
          box.minX < p.maxX + g - CLEAR_EPS &&
          p.minX < box.maxX + g - CLEAR_EPS &&
          box.minY < p.maxY + g - CLEAR_EPS &&
          p.minY < box.maxY + g - CLEAR_EPS
        ) {
          if (p.maxX > farX) farX = p.maxX;
          if (p.maxY > farY) farY = p.maxY;
        }
      }
      if (farX === -Infinity) break;
      const right = farX + g - box.minX;
      const down = farY + g - box.minY;
      const goRight = axis === 'x' || (axis === undefined && right <= down);
      const step = goRight ? { dx: right, dy: 0 } : { dx: 0, dy: down };
      box = shifted(box, step);
      dx += step.dx;
      dy += step.dy;
    }
    placed.push(box);
    if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) out.set(it.id, { dx, dy });
  }
  return out;
}

// Move every item so the chosen edge or centre matches the union box of the items. Items that
// already are aligned are omitted. With `opts.gap` the items that would pile up on the aligned edge
// slide along the other axis (a row aligned left becomes a column, in the row's order).
export function align(
  items: readonly { id: string; box: Box }[],
  mode: AlignMode,
  opts: ArrangeOpts = {},
): Map<string, Delta> {
  const out = new Map<string, Delta>();
  if (items.length < 2) return out;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { box } of items) {
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
  }
  for (const { id, box } of items) {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case 'left':
        dx = minX - box.minX;
        break;
      case 'centerX':
        dx = (minX + maxX) / 2 - boxCx(box);
        break;
      case 'right':
        dx = maxX - box.maxX;
        break;
      case 'top':
        dy = minY - box.minY;
        break;
      case 'middleY':
        dy = (minY + maxY) / 2 - boxCy(box);
        break;
      case 'bottom':
        dy = maxY - box.maxY;
        break;
    }
    if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) out.set(id, { dx, dy });
  }
  if (opts.gap !== undefined) {
    // The aligned edge fixes one axis; the boxes are free on the other.
    const free = mode === 'left' || mode === 'centerX' || mode === 'right' ? 'y' : 'x';
    // Stacked in the order they had before: once aligned they all share the edge, which says nothing.
    const aligned = bandOrder(items, free).map((it) => ({
      id: it.id,
      box: shifted(it.box, out.get(it.id)),
    }));
    for (const [id, d] of separate(aligned, opts.gap, free, true)) addDelta(out, id, d);
  }
  return out;
}

// Equal GAPS between consecutive boxes (not equal centres): sorted by position along the axis,
// the two extremes stay and the ones between slide. Needs three or more items. With `opts.gap` the
// gap is never smaller than that (a span too short for the boxes would overlap them): then the last
// ones move on past the far extreme.
export function distribute(
  items: readonly { id: string; box: Box }[],
  axis: 'x' | 'y',
  opts: ArrangeOpts = {},
): Map<string, Delta> {
  const out = new Map<string, Delta>();
  const n = items.length;
  if (n < 3) return out;
  const horizontal = axis === 'x';
  const lo = (b: Box): number => (horizontal ? b.minX : b.minY);
  const hi = (b: Box): number => (horizontal ? b.maxX : b.maxY);
  const size = (b: Box): number => (horizontal ? boxW(b) : boxH(b));
  const centre = (b: Box): number => (horizontal ? boxCx(b) : boxCy(b));

  const sorted = items.slice().sort((a, b) => {
    const d = centre(a.box) - centre(b.box) || lo(a.box) - lo(b.box);
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  let total = 0;
  for (const it of sorted) total += size(it.box);
  const start = lo(sorted[0].box);
  let gap = (hi(sorted[n - 1].box) - start - total) / (n - 1);
  if (opts.gap !== undefined && gap < opts.gap) gap = opts.gap;

  let cursor = start;
  for (const { id, box } of sorted) {
    const d = cursor - lo(box);
    if (Math.abs(d) > EPS) out.set(id, horizontal ? { dx: d, dy: 0 } : { dx: 0, dy: d });
    cursor += size(box) + gap;
  }
  return out;
}

// Equal width: every item takes the median width; aspect-locked items (cards) scale their
// height along. Items that already have the median width are omitted.
export function equalWidth(
  items: readonly { id: string; w: number; h: number; aspectLocked: boolean }[],
): Map<string, { w: number; h: number }> {
  const out = new Map<string, { w: number; h: number }>();
  if (items.length === 0) return out;
  const target = median(items.map((it) => it.w));
  for (const it of items) {
    if (Math.abs(it.w - target) <= EPS) continue;
    out.set(it.id, {
      w: target,
      h: it.aspectLocked && it.w > 0 ? (it.h * target) / it.w : it.h,
    });
  }
  return out;
}
