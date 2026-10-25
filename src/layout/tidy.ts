// Tidy: reorder cards into a masonry grid in reading order. Pure and in world space; the caller resets
// any rotation (a move carries no `rot`).
import { emptyBox, type Aabb } from '../interact/geometry';
import type { Box } from '../math';
import { effectiveAspect, masonry, slotWidth, type LayoutItem } from './masonry';
import { bandOrder } from './order';
import { placementGap } from './placement';
import { clamp, median } from './stats';

/** A card as {@link tidy} sees it: id, box and aspect. */
export interface TidyItem {
  id: string;
  // Items with `fixed` set stay put (they do not take part in the grid).
  fixed?: boolean;
  // A free-aspect item keeps its own size in the grid; the others take the median width and their aspect.
  free?: boolean;
  // World AABB of the painted element (what reading order and the default anchor use).
  box: Aabb;
  // Card size (what the grid places).
  w: number;
  h: number;
}

/** What {@link tidy} returns: the new rect of every card. */
export interface TidyResult {
  // New {@link Box} of every participating item, in world px.
  moves: Map<string, Box>;
  count: number;
  bounds: Aabb;
}

const MAX_COLUMNS = 10;

function participates(it: TidyItem): boolean {
  return (
    !it.fixed &&
    Number.isFinite(it.w) &&
    Number.isFinite(it.h) &&
    it.w > 0 &&
    it.h > 0
  );
}

/** Reorders cards into a masonry grid in reading order, anchored at their current top-left. Pure. */
export function tidy(
  items: readonly TidyItem[],
  opts: {
    anchor?: { x: number; y: number };
    // Space between items (default: `placementGap` of the median width).
    gap?: number;
    // Number of columns (default: roughly square block, at most 10).
    columns?: number;
  } = {},
): TidyResult {
  const part = items.filter(participates);
  if (part.length < 2) {
    const at =
      opts.anchor ??
      (part.length === 1 ? { x: part[0].box.minX, y: part[0].box.minY } : { x: 0, y: 0 });
    return {
      moves: new Map(),
      count: 0,
      bounds: { minX: at.x, minY: at.y, maxX: at.x, maxY: at.y },
    };
  }

  // 1. Cluster by vertical centre (a row's tolerance is half the median height, measured
  // from the row's running mean centre), rows top to bottom, each sorted left to right.
  const ordered = bandOrder(part, 'y');
  const n = ordered.length;

  // 2. W is the median width of the cards; free-aspect items keep their size.
  const cardWidths: number[] = [];
  for (const it of ordered) if (!it.free) cardWidths.push(it.w);
  const width = median(cardWidths.length > 0 ? cardWidths : ordered.map((it) => it.w));
  const gap = opts.gap ?? placementGap(width);

  // 3. c = clamp(round(sqrt(n * mean h/w)), 1, 10).
  const layout: LayoutItem[] = new Array<LayoutItem>(n);
  let aspectSum = 0;
  for (let i = 0; i < n; i++) {
    const it = ordered[i];
    const aspect = effectiveAspect(it.h / it.w);
    aspectSum += aspect;
    layout[i] = it.free ? { aspect, w: it.w, h: it.h } : { aspect };
  }
  const columns =
    opts.columns ?? clamp(Math.round(Math.sqrt(n * (aspectSum / n))), 1, MAX_COLUMNS);

  // 4. Anchored at the current top-left of what moves (or the caller's anchor). A fixed-size item
  // wider than W gets a wider slot so it cannot overlap the next column.
  const block = masonry(layout, { width, gap, columns, slot: slotWidth(layout, width) });
  let ax: number;
  let ay: number;
  if (opts.anchor) {
    ax = opts.anchor.x;
    ay = opts.anchor.y;
  } else {
    const u = emptyBox();
    for (const it of ordered) {
      if (it.box.minX < u.minX) u.minX = it.box.minX;
      if (it.box.minY < u.minY) u.minY = it.box.minY;
    }
    ax = u.minX;
    ay = u.minY;
  }

  const moves: TidyResult['moves'] = new Map();
  for (let i = 0; i < n; i++) {
    const r = block.rects[i];
    moves.set(ordered[i].id, { x: ax + r.x, y: ay + r.y, w: r.w, h: r.h });
  }
  return {
    moves,
    count: n,
    bounds: { minX: ax, minY: ay, maxX: ax + block.width, maxY: ay + block.height },
  };
}
