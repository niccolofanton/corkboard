// Masonry packing: the one primitive behind both the placement of new cards and "tidy into a grid".
// Pure: items in, rectangles relative to the block's top-left out.
import { DEFAULTS } from '../types';

export const PLACEMENT_FALLBACK_WIDTH: number = DEFAULTS.cardWidth;
export const PLACEMENT_FALLBACK_ASPECT: number = DEFAULTS.cardAspect;

export interface LayoutItem {
  // Height / width. 0, negative, NaN or missing falls back to PLACEMENT_FALLBACK_ASPECT.
  aspect: number;
  // Explicit width. Such an item sits left-aligned in a column slot.
  w?: number;
  // Explicit height. Only for items that keep their exact size (tidy keeps a free-aspect card's real
  // height instead of re-deriving it from a rounded aspect).
  h?: number;
}

export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MasonryResult {
  rects: LayoutRect[];
  // Bounds of the block: gaps only between items, none after the last.
  width: number;
  height: number;
}

export function effectiveAspect(aspect: number | undefined): number {
  return aspect !== undefined && Number.isFinite(aspect) && aspect > 0
    ? aspect
    : PLACEMENT_FALLBACK_ASPECT;
}

// Column slot width that never lets an item with its own (larger) width spill into the next
// column: callers that mix fixed-width items with resized cards pass it as `opts.slot`.
export function slotWidth(items: readonly LayoutItem[], width: number): number {
  let slot = width;
  for (let i = 0; i < items.length; i++) {
    const w = items[i].w;
    if (w !== undefined && w > slot) slot = w;
  }
  return slot;
}

// Items go in order into the shortest column, the leftmost when tied. Heights are integers
// (width * aspect rounded) so equal-height columns tie exactly and the layout is reproducible.
export function masonry(
  items: readonly LayoutItem[],
  opts: { width: number; gap: number; columns: number; slot?: number },
): MasonryResult {
  const cols = Math.max(1, Math.floor(opts.columns));
  const slot = (opts.slot ?? opts.width) + opts.gap;
  // Where the next item of each column starts (previous bottom + gap; 0 while empty).
  const next = new Float64Array(cols);
  const rects = new Array<LayoutRect>(items.length);
  let width = 0;
  let height = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let c = 0;
    let best = next[0];
    for (let k = 1; k < cols; k++) {
      if (next[k] < best) {
        best = next[k];
        c = k;
      }
    }
    const w = it.w !== undefined && it.w > 0 ? it.w : opts.width;
    const h =
      it.h !== undefined && it.h > 0
        ? it.h
        : Math.max(1, Math.round(w * effectiveAspect(it.aspect)));
    const x = c * slot;
    const y = best;
    rects[i] = { x, y, w, h };
    next[c] = y + h + opts.gap;
    if (x + w > width) width = x + w;
    if (y + h > height) height = y + h;
  }
  return { rects, width, height };
}
