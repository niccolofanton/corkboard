// Resize sessions. A `ResizeSession` is created on pointer-down on a handle and `update`d on every
// pointer move; it returns the new geometry of every affected element as patches the caller applies.
// Pure: no store writes, no Pixi, no DOM. Pointers and handle geometry are WORLD coordinates.
//
// One element resizes about the corner or edge opposite the handle (about the centre with Alt), keeping
// its aspect when it is locked or Shift is held. Several elements scale together, uniformly, about the
// shared box.
import type { Box } from './geometry';
import { DEG } from './geometry';
import type { HandleId } from './handles';
import { geometryBox, HANDLE_DIRS } from './handles';
import type { ElementReader } from './reader';


export interface Mods {
  shift: boolean;
  alt: boolean;
  // Disables snapping while held.
  ctrl: boolean;
}

// Wired by the controller: `box` is the proposed world AABB of the selection and `edges` the dragged
// edges (both objects are reused between calls: do not keep them). Returns the correction to ADD to
// the dragged edges.
export type Snapper = (
  box: Box,
  edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
) => { dx: number; dy: number };

// New geometry of one element.
export interface GeometryPatch {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Smallest card edge a resize can reach, world px.
export const MIN_SIZE = 24;
// Largest a card can be scaled to (long side), world px.
export const MAX_SIZE = 4000;

type Mode = 'noop' | 'single' | 'multi';

interface Item {
  id: string;
  // Start geometry: world top-left, size, rotation (degrees) and its trig, world centre.
  wx: number;
  wy: number;
  w: number;
  h: number;
  rot: number;
  cos: number;
  sin: number;
  cx: number;
  cy: number;
  aspectLocked: boolean;
  patch: GeometryPatch;
}

// Scratch result of `solveResize`: new rect in the OLD local frame (origin = old top-left).
const S = { l: 0, t: 0, w: 0, h: 0 };

// Where a resized axis starts, in the old local frame. The anchor (the edge opposite the dragged one)
// stays put; `flipped` means the dragged edge crossed it. Centred when resizing about the centre or
// when the axis is not being dragged.
function placeAxis(f: number, size: number, n: number, alt: boolean, flipped: boolean): number {
  if (f === 0 || alt) return (size - n) / 2;
  const anchor = f > 0 ? 0 : size;
  const end = anchor + (flipped ? -f : f) * n;
  return end < anchor ? end : anchor;
}

// Resizes a w x h box by dragging the handle direction (fx, fy) by (dx, dy), both in the box's own
// frame. `lock` keeps the aspect (the larger relative scale wins), `alt` resizes about the centre.
function solveResize(
  w: number,
  h: number,
  fx: number,
  fy: number,
  dx: number,
  dy: number,
  alt: boolean,
  lock: boolean,
  minW: number,
  minH: number,
  maxScale: number,
): void {
  const k = alt ? 2 : 1;
  if (lock && w > 0 && h > 0) {
    const sx = fx !== 0 ? (w + k * fx * dx) / w : 0;
    const sy = fy !== 0 ? (h + k * fy * dy) / h : 0;
    let s: number;
    if (fx !== 0 && fy !== 0) s = Math.max(sx, sy);
    else s = fx !== 0 ? sx : sy;
    let a = s;
    const minS = Math.max(minW / w, minH / h);
    if (a < minS) a = minS;
    if (a > maxScale) a = maxScale;
    S.w = w * a;
    S.h = h * a;
    S.l = placeAxis(fx, w, S.w, alt, false);
    S.t = placeAxis(fy, h, S.h, alt, false);
    return;
  }
  if (fx === 0) {
    S.l = 0;
    S.w = w;
  } else {
    const n = Math.max(w + k * fx * dx, minW);
    S.w = n;
    S.l = placeAxis(fx, w, n, alt, false);
  }
  if (fy === 0) {
    S.t = 0;
    S.h = h;
  } else {
    const n = Math.max(h + k * fy * dy, minH);
    S.h = n;
    S.t = placeAxis(fy, h, n, alt, false);
  }
}

export class ResizeSession {
  readonly handle: HandleId;
  readonly affected: readonly string[];

  private readonly mode: Mode;
  private readonly items: Item[] = [];
  private readonly out = new Map<string, GeometryPatch>();
  private readonly start: { x: number; y: number };
  // Handle direction in the element's own frame.
  private fx = 0;
  private fy = 0;
  // Shared geometry box of the items (multi resize).
  private bx = 0;
  private by = 0;
  private bw = 0;
  private bh = 0;
  // Snapper scratch (reused: no allocation per pointer move).
  private readonly snapBox: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly snapEdges = { left: false, right: false, top: false, bottom: false };
  private readonly centre = { x: 0, y: 0 };

  constructor(
    reader: ElementReader,
    ids: readonly string[],
    handle: HandleId,
    startWorld: { x: number; y: number },
  ) {
    this.handle = handle;
    this.start = { x: startWorld.x, y: startWorld.y };
    const seen = new Set<string>();
    const affected: string[] = [];
    for (const id of ids) {
      const el = reader.get(id);
      if (!el || el.locked || seen.has(el.id)) continue;
      seen.add(el.id);
      const a = el.rot * DEG;
      const item: Item = {
        id: el.id,
        wx: el.x,
        wy: el.y,
        w: el.w,
        h: el.h,
        rot: el.rot,
        cos: el.rot === 0 ? 1 : Math.cos(a),
        sin: el.rot === 0 ? 0 : Math.sin(a),
        cx: el.x + el.w / 2,
        cy: el.y + el.h / 2,
        aspectLocked: el.aspectLocked,
        // Identity until the first update.
        patch: { x: el.x, y: el.y, w: el.w, h: el.h },
      };
      this.items.push(item);
      this.out.set(item.id, item.patch);
      affected.push(item.id);
    }
    this.affected = affected;
    this.mode = this.items.length === 0 ? 'noop' : this.items.length > 1 ? 'multi' : 'single';
    const d = HANDLE_DIRS[handle];
    this.fx = d[0];
    this.fy = d[1];
    if (this.mode === 'multi') {
      const b = geometryBox(
        this.items.map((it) => ({ x: it.wx, y: it.wy, w: it.w, h: it.h, rot: it.rot })),
      );
      if (b !== null) {
        this.bx = b.minX;
        this.by = b.minY;
        this.bw = b.maxX - b.minX;
        this.bh = b.maxY - b.minY;
      }
    }
  }

  // The geometry of every affected element at this pointer position (world). The returned Map and its
  // patches are reused by the next call: apply them before calling `update` again.
  update(
    pointer: { x: number; y: number },
    mods: Mods,
    snap?: Snapper,
  ): Map<string, GeometryPatch> {
    const useSnap = snap !== undefined && !mods.ctrl ? snap : undefined;
    if (this.mode === 'single') this.updateSingle(pointer.x, pointer.y, mods, useSnap);
    else if (this.mode === 'multi') this.updateMulti(pointer.x, pointer.y, mods, useSnap);
    return this.out;
  }

  // ── single element ─────────────────────────────────────────────────────────

  private solveSingle(it: Item, px: number, py: number, mods: Mods): void {
    const dxw = px - this.start.x;
    const dyw = py - this.start.y;
    // Pointer delta in the element's own (rotated) frame.
    const dl = dxw * it.cos + dyw * it.sin;
    const dv = -dxw * it.sin + dyw * it.cos;
    const long = Math.max(it.w, it.h);
    solveResize(
      it.w,
      it.h,
      this.fx,
      this.fy,
      dl,
      dv,
      mods.alt,
      it.aspectLocked || mods.shift,
      MIN_SIZE,
      MIN_SIZE,
      long > 0 ? MAX_SIZE / long : Infinity,
    );
  }

  // World centre of the solved rect.
  private solvedCenter(it: Item, out: { x: number; y: number }): void {
    const lx = S.l + S.w / 2 - it.w / 2;
    const ly = S.t + S.h / 2 - it.h / 2;
    out.x = it.cx + lx * it.cos - ly * it.sin;
    out.y = it.cy + lx * it.sin + ly * it.cos;
  }

  private updateSingle(px: number, py: number, mods: Mods, snap: Snapper | undefined): void {
    const it = this.items[0];
    this.solveSingle(it, px, py, mods);
    // Snapping is axis-aligned: only elements turned by whole quarter turns have world edges that
    // correspond to their own edges.
    if (snap !== undefined && it.rot % 90 === 0) {
      this.solvedCenter(it, this.centre);
      const swap = Math.abs(it.rot / 90) % 2 === 1;
      const ew = swap ? S.h : S.w;
      const eh = swap ? S.w : S.h;
      const b = this.snapBox;
      b.minX = this.centre.x - ew / 2;
      b.maxX = this.centre.x + ew / 2;
      b.minY = this.centre.y - eh / 2;
      b.maxY = this.centre.y + eh / 2;
      // The dragged edge directions in world axes (exact for quarter turns).
      const dirX = Math.round(this.fx * it.cos - this.fy * it.sin);
      const dirY = Math.round(this.fx * it.sin + this.fy * it.cos);
      this.setEdges(dirX, dirY, mods.alt);
      const c = snap(b, this.snapEdges);
      if (c.dx !== 0 || c.dy !== 0) this.solveSingle(it, px + c.dx, py + c.dy, mods);
    }
    this.solvedCenter(it, this.centre);
    const p = it.patch;
    p.x = this.centre.x - S.w / 2;
    p.y = this.centre.y - S.h / 2;
    p.w = S.w;
    p.h = S.h;
  }

  private setEdges(dirX: number, dirY: number, alt: boolean): void {
    const e = this.snapEdges;
    e.left = dirX < 0 || (alt && dirX !== 0);
    e.right = dirX > 0 || (alt && dirX !== 0);
    e.top = dirY < 0 || (alt && dirY !== 0);
    e.bottom = dirY > 0 || (alt && dirY !== 0);
  }

  // ── several elements ───────────────────────────────────────────────────────

  private solveMulti(px: number, py: number, mods: Mods): void {
    solveResize(
      this.bw,
      this.bh,
      this.fx,
      this.fy,
      px - this.start.x,
      py - this.start.y,
      mods.alt,
      true,
      MIN_SIZE,
      MIN_SIZE,
      Infinity,
    );
  }

  private updateMulti(px: number, py: number, mods: Mods, snap: Snapper | undefined): void {
    this.solveMulti(px, py, mods);
    if (snap !== undefined) {
      const b = this.snapBox;
      b.minX = this.bx + S.l;
      b.minY = this.by + S.t;
      b.maxX = b.minX + S.w;
      b.maxY = b.minY + S.h;
      this.setEdges(this.fx, this.fy, mods.alt);
      const c = snap(b, this.snapEdges);
      if (c.dx !== 0 || c.dy !== 0) this.solveMulti(px + c.dx, py + c.dy, mods);
    }
    const s = this.bw > 0 ? S.w / this.bw : 1;
    const left = this.bx + S.l;
    const top = this.by + S.t;
    for (const it of this.items) {
      const w = Math.max(it.w * s, 1);
      const h = Math.max(it.h * s, 1);
      // Scale the centre about the box origin so rotated elements stay consistent.
      const ncx = left + (it.cx - this.bx) * s;
      const ncy = top + (it.cy - this.by) * s;
      const p = it.patch;
      p.x = ncx - w / 2;
      p.y = ncy - h / 2;
      p.w = w;
      p.h = h;
    }
  }
}
