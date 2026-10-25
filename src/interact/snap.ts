// The snapping session of a drag or a resize: smart guides (alignment, equal gaps, size matches against
// the cards around) plus an optional snap to the background grid. Built once at gesture start from the
// cards near the viewport, then asked on every pointer move.
import type { Store } from '../store';
import type { Card } from '../types';
import type { Rect } from '../math';
import type { Aabb } from './geometry';
import { boxCx, boxCy, elementBox } from './geometry';
import {
  buildSnapIndex,
  GUIDE_OVERSHOOT_PX,
  resetSnapHysteresis,
  snapMove,
  snapResize,
  SNAP_THRESHOLD_PX,
  type Guide,
  type ResizeEdges,
  type SnapIndex,
  type SnapResult,
} from './snapping';

// At most this many cards are indexed (the nearest to the viewport centre): the equal-gap search is
// quadratic in the worst case.
const MAX_CANDIDATES = 400;
// The viewport grown by this fraction on every side is searched for candidates.
const VIEW_GROW = 0.25;

/** Snapping while moving and resizing (`CorkboardOptions.snapping`, `board.setSnapping()`). */
export interface SnapSettings {
  /** Alignment lines, equal gaps and size matches against other cards, drawn as guides. */
  guides: boolean;
  /** Snap to the background dot grid where no guide snapped. */
  grid: boolean;
}

export const DEFAULT_SNAPPING: SnapSettings = { guides: true, grid: false };

// What a resize snap asks of the caller: see `SnapSession.resize`.
export interface ResizeSnap {
  dx: number;
  dy: number;
  edgeX?: 'min' | 'max';
  edgeY?: 'min' | 'max';
  guides: readonly Guide[];
}

const isAxis = (g: Guide, axis: 'x' | 'y'): boolean => g.axis === axis;

export class SnapSession {
  private index: SnapIndex | null = null;
  private zoom = 1;
  private readonly result: SnapResult = { dx: 0, dy: 0, guides: [] };
  private readonly hits: Card[] = [];

  constructor(
    private readonly settings: SnapSettings,
    private readonly gridSize: number,
  ) {}

  // `view` is the visible world rect; `exclude` are the cards being moved.
  begin(store: Store, view: Rect, zoom: number, exclude: ReadonlySet<string>): void {
    this.zoom = zoom > 0 ? zoom : 1;
    this.index = null;
    resetSnapHysteresis(this.result);
    if (!this.settings.guides) return;
    const gx = (view.x1 - view.x0) * VIEW_GROW;
    const gy = (view.y1 - view.y0) * VIEW_GROW;
    const box: Aabb = { minX: view.x0 - gx, minY: view.y0 - gy, maxX: view.x1 + gx, maxY: view.y1 + gy };
    const cx = (view.x0 + view.x1) / 2;
    const cy = (view.y0 + view.y1) / 2;
    const cands: { id: string; box: Aabb; d: number }[] = [];
    for (const el of store.searchInto(box, this.hits)) {
      if (exclude.has(el.id)) continue;
      const b = elementBox(el);
      cands.push({ id: el.id, box: b, d: Math.hypot(boxCx(b) - cx, boxCy(b) - cy) });
    }
    if (cands.length > MAX_CANDIDATES) {
      cands.sort((a, b) => a.d - b.d);
      cands.length = MAX_CANDIDATES;
    }
    this.index = buildSnapIndex(cands);
  }

  end(): void {
    this.index = null;
  }

  private gridDelta(v: number): number {
    const g = this.gridSize;
    return Math.round(v / g) * g - v;
  }

  // The correction to add to a box being moved, and the guides to draw.
  move(box: Aabb): { dx: number; dy: number; guides: readonly Guide[] } {
    const threshold = SNAP_THRESHOLD_PX / this.zoom;
    let dx = 0;
    let dy = 0;
    let guides: readonly Guide[] = [];
    if (this.index) {
      const r = snapMove(this.index, box, threshold, GUIDE_OVERSHOOT_PX / this.zoom, this.result);
      dx = r.dx;
      dy = r.dy;
      guides = r.guides;
    }
    if (this.settings.grid) {
      const gx = this.gridDelta(box.minX);
      const gy = this.gridDelta(box.minY);
      if (!guides.some((g) => isAxis(g, 'x')) && Math.abs(gx) <= threshold) dx = gx;
      if (!guides.some((g) => isAxis(g, 'y')) && Math.abs(gy) <= threshold) dy = gy;
    }
    return { dx, dy, guides };
  }

  // The correction to add to the dragged edges of a box being resized. A symmetric resize flags both
  // edges of an axis: `edgeX` / `edgeY` then say which one the correction belongs to.
  resize(box: Aabb, edges: ResizeEdges): ResizeSnap {
    const threshold = SNAP_THRESHOLD_PX / this.zoom;
    let dx = 0;
    let dy = 0;
    let edgeX: 'min' | 'max' | undefined;
    let edgeY: 'min' | 'max' | undefined;
    let guides: readonly Guide[] = [];
    if (this.index) {
      const r = snapResize(
        this.index,
        box,
        edges,
        threshold,
        GUIDE_OVERSHOOT_PX / this.zoom,
        this.result,
      );
      dx = r.dx;
      dy = r.dy;
      edgeX = r.edgeX;
      edgeY = r.edgeY;
      guides = r.guides;
    }
    if (this.settings.grid) {
      if (!guides.some((g) => isAxis(g, 'x'))) {
        const g = this.gridEdge(box.minX, box.maxX, edges.left, edges.right, threshold);
        if (g) {
          dx = g.delta;
          edgeX = g.edge;
        }
      }
      if (!guides.some((g) => isAxis(g, 'y'))) {
        const g = this.gridEdge(box.minY, box.maxY, edges.top, edges.bottom, threshold);
        if (g) {
          dy = g.delta;
          edgeY = g.edge;
        }
      }
    }
    return { dx, dy, edgeX, edgeY, guides };
  }

  // The grid correction of the flagged edge of an axis (the nearer one when both are), within the threshold.
  private gridEdge(
    min: number,
    max: number,
    lo: boolean | undefined,
    hi: boolean | undefined,
    threshold: number,
  ): { delta: number; edge: 'min' | 'max' } | null {
    const a = lo ? this.gridDelta(min) : Infinity;
    const b = hi ? this.gridDelta(max) : Infinity;
    const delta = Math.abs(a) <= Math.abs(b) ? a : b;
    if (!(Math.abs(delta) <= threshold)) return null;
    return { delta, edge: delta === a ? 'min' : 'max' };
  }
}
