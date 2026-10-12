// Point hit testing against elements. Pure: the store is reached only through the structural
// `ElementReader`.
//
// The query is two-phase: a spatial search with a tiny box around the point (grown by the screen
// tolerance), then an exact rotated-rect test on the few candidates. Everything is in WORLD units; the
// screen-px tolerance is divided by the zoom.
import type { Element } from '../types';
import type { Box } from './geometry';
import { pointInRotatedRect } from './geometry';
import type { ElementReader } from './reader';

export interface HitOptions {
  // Camera scale; the tolerance is `tolerancePx / zoom` in world units.
  zoom: number;
  // Screen px (default 4).
  tolerancePx?: number;
  // Ignore locked elements (a marquee does). Default false: a click on a locked element hits it.
  skipLocked?: boolean;
  filter?: (el: Element) => boolean;
}

const DEFAULT_TOLERANCE_PX = 4;
const candidates: Element[] = [];
const searchBox: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

const safeZoom = (z: number): number => (z > 0 && Number.isFinite(z) ? z : 1);

function eligible(el: Element, opts: HitOptions): boolean {
  if (opts.skipLocked && el.locked) return false;
  return opts.filter === undefined || opts.filter(el);
}

function collect(reader: ElementReader, wx: number, wy: number, tol: number): Element[] {
  searchBox.minX = wx - tol;
  searchBox.minY = wy - tol;
  searchBox.maxX = wx + tol;
  searchBox.maxY = wy + tol;
  return reader.searchInto(searchBox, candidates);
}

const hits = (el: Element, wx: number, wy: number, tol: number): boolean =>
  pointInRotatedRect({ x: el.x, y: el.y, w: el.w, h: el.h, rot: el.rot }, wx, wy, tol);

// The topmost element under the point (by draw order), or null.
export function hitTest(
  reader: ElementReader,
  wx: number,
  wy: number,
  opts: HitOptions,
): Element | null {
  const tol = (opts.tolerancePx ?? DEFAULT_TOLERANCE_PX) / safeZoom(opts.zoom);
  const list = collect(reader, wx, wy, tol);
  let best: Element | null = null;
  let bestRank = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (!eligible(el, opts)) continue;
    const rank = reader.rank(el.id);
    // Only elements above the current best can win: skip the exact test for the others.
    if (rank <= bestRank) continue;
    if (!hits(el, wx, wy, tol)) continue;
    best = el;
    bestRank = rank;
  }
  list.length = 0;
  return best;
}

// Every element under the point, top to bottom. `out` is cleared and returned.
export function hitTestAll(
  reader: ElementReader,
  wx: number,
  wy: number,
  opts: HitOptions,
  out: Element[] = [],
): Element[] {
  out.length = 0;
  const tol = (opts.tolerancePx ?? DEFAULT_TOLERANCE_PX) / safeZoom(opts.zoom);
  const list = collect(reader, wx, wy, tol);
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (eligible(el, opts) && hits(el, wx, wy, tol)) out.push(el);
  }
  list.length = 0;
  if (out.length > 1) out.sort((a, b) => reader.rank(b.id) - reader.rank(a.id));
  return out;
}
