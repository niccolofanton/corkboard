// Placement: where a block of new cards lands. Computed once and re-run only when its inputs change;
// while a pointer moves the caller can just translate the cached result. Everything is in world space.
import type { Aabb } from '../interact/geometry';
import {
  PLACEMENT_FALLBACK_ASPECT,
  PLACEMENT_FALLBACK_WIDTH,
  effectiveAspect,
  masonry,
  slotWidth,
  type LayoutItem,
  type LayoutRect,
} from './masonry';
import { clamp, median } from './stats';

// Below this many cards on the board the median is noise: use the default card width.
const MIN_CARDS_FOR_MEDIAN = 3;
const MIN_GAP = 12;
const MAX_GAP = 48;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 10;

/**
 * W: the median width of the cards already on the canvas, so new cards blend in (>= 3 cards),
 * else the default card width.
 */
export function placementWidth(existingCardWidths: readonly number[]): number {
  const widths: number[] = [];
  for (let i = 0; i < existingCardWidths.length; i++) {
    const w = existingCardWidths[i];
    if (Number.isFinite(w) && w > 0) widths.push(w);
  }
  return widths.length >= MIN_CARDS_FOR_MEDIAN ? median(widths) : PLACEMENT_FALLBACK_WIDTH;
}

/**
 * G: a tenth of the width, kept between 12 and 48 so tiny cards still breathe and huge ones
 * don't float apart.
 */
export function placementGap(width: number): number {
  return clamp(Math.round(width / 10), MIN_GAP, MAX_GAP);
}

/** c: roughly square block. One item is one column; Shift (singleRow) lays everything out in a row. */
export function placementColumns(n: number, meanAspect: number, singleRow = false): number {
  if (n <= 1) return 1;
  if (singleRow) return n;
  return clamp(Math.round(Math.sqrt(n * effectiveAspect(meanAspect))), MIN_COLUMNS, MAX_COLUMNS);
}

/** Input of {@link planPlacement}: the new cards and the room around them. */
export interface PlacementInput {
  items: readonly LayoutItem[];
  existingCardWidths: readonly number[];
  // Shift held: a single row.
  singleRow?: boolean;
  anchor: // The block's top-left sits exactly at (x, y): n == 1, the caller keeps the grab offset.
    | { kind: 'grab'; x: number; y: number }
    // The block is centred on (x, y): n >= 2, the drop scatters outward from the stack.
    | { kind: 'center'; x: number; y: number };
}

/** What {@link planPlacement} returns: where the new cards go. */
export interface PlacementResult {
  // World rectangles in input order.
  rects: LayoutRect[];
  // Bounds of the block (what snapping and the outline use).
  bounds: Aabb;
  // The item width W (not the block width: that is boxW(bounds)).
  width: number;
  gap: number;
  columns: number;
}

/**
 * Pure and cheap (100 items: well under a millisecond): the caller caches the result per carry
 * and only moves it with translatePlacement[InPlace].
 */
export function planPlacement(input: PlacementInput): PlacementResult {
  const { items, anchor } = input;
  const n = items.length;
  const width = placementWidth(input.existingCardWidths);
  const gap = placementGap(width);

  let aspectSum = 0;
  for (let i = 0; i < n; i++) aspectSum += effectiveAspect(items[i].aspect);
  const meanAspect = n > 0 ? aspectSum / n : PLACEMENT_FALLBACK_ASPECT;
  const columns = placementColumns(n, meanAspect, input.singleRow);

  const block = masonry(items, { width, gap, columns, slot: slotWidth(items, width) });
  const ox = anchor.kind === 'center' ? anchor.x - block.width / 2 : anchor.x;
  const oy = anchor.kind === 'center' ? anchor.y - block.height / 2 : anchor.y;
  const rects = block.rects;
  for (let i = 0; i < rects.length; i++) {
    rects[i].x += ox;
    rects[i].y += oy;
  }
  return {
    rects,
    bounds: { minX: ox, minY: oy, maxX: ox + block.width, maxY: oy + block.height },
    width,
    gap,
    columns,
  };
}

/** Shifted copy; the input is untouched. */
export function translatePlacement(
  result: PlacementResult,
  dx: number,
  dy: number,
): PlacementResult {
  const rects = new Array<LayoutRect>(result.rects.length);
  for (let i = 0; i < rects.length; i++) {
    const r = result.rects[i];
    rects[i] = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
  }
  const b = result.bounds;
  return {
    ...result,
    rects,
    bounds: { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy },
  };
}

/** Per-pointer-move path: no allocation, mutates the cached result and returns it. */
export function translatePlacementInPlace(
  result: PlacementResult,
  dx: number,
  dy: number,
): PlacementResult {
  const rects = result.rects;
  for (let i = 0; i < rects.length; i++) {
    rects[i].x += dx;
    rects[i].y += dy;
  }
  const b = result.bounds;
  b.minX += dx;
  b.maxX += dx;
  b.minY += dy;
  b.maxY += dy;
  return result;
}
