// World-space geometry of elements: the one place that knows how (x, y, w, h, rot) turn into
// rectangles, AABBs (the rbush entries) and point tests. Pure; shared by the store (index), the
// renderer, hit testing, snapping and layout.
//
// Convention (types.ts): `rot` is degrees clockwise about the element's centre.
import type { Element } from '../types';

// rbush-compatible box.
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

export const DEG = Math.PI / 180;

export const emptyBox = (): Box => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
});
export const boxW = (b: Box): number => b.maxX - b.minX;
export const boxH = (b: Box): number => b.maxY - b.minY;
export const boxCx = (b: Box): number => (b.minX + b.maxX) / 2;
export const boxCy = (b: Box): number => (b.minY + b.maxY) / 2;

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
export function boxContains(outer: Box, inner: Box): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}
export function boxUnion(a: Box, b: Box): Box {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}
export function boxGrow(b: Box, by: number): Box {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}
export function boxOfRect(r: { x: number; y: number; w: number; h: number }): Box {
  return { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
}

export function worldRectOf(el: Pick<Element, 'x' | 'y' | 'w' | 'h' | 'rot'>): WorldRect {
  return { x: el.x, y: el.y, w: el.w, h: el.h, rot: el.rot };
}

export function rotatedExtent(w: number, h: number, rotDeg: number): { w: number; h: number } {
  if (rotDeg === 0) return { w, h };
  const a = rotDeg * DEG;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return { w: w * c + h * s, h: w * s + h * c };
}

// World AABB of an element (rotation included).
export function elementBox(el: Pick<Element, 'x' | 'y' | 'w' | 'h' | 'rot'>): Box {
  const r = worldRectOf(el);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const e = rotatedExtent(r.w, r.h, r.rot);
  return { minX: cx - e.w / 2, minY: cy - e.h / 2, maxX: cx + e.w / 2, maxY: cy + e.h / 2 };
}

// The four corners of a world rect, clockwise from the top-left: [x0, y0, x1, y1, x2, y2, x3, y3].
export function corners(r: WorldRect): number[] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const hw = r.w / 2;
  const hh = r.h / 2;
  const a = r.rot * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pts: number[] = [];
  for (const [dx, dy] of [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ]) {
    pts.push(cx + dx * c - dy * s, cy + dx * s + dy * c);
  }
  return pts;
}

// A world point expressed in the rect's own (unrotated, origin at its top-left) frame.
export function toRectLocal(r: WorldRect, px: number, py: number): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const a = -r.rot * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = px - cx;
  const dy = py - cy;
  return { x: dx * c - dy * s + r.w / 2, y: dx * s + dy * c + r.h / 2 };
}

// Rect-local -> world.
export function fromRectLocal(r: WorldRect, lx: number, ly: number): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const a = r.rot * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = lx - r.w / 2;
  const dy = ly - r.h / 2;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

// `tol` grows the rect on every side (world px).
export function pointInRotatedRect(r: WorldRect, px: number, py: number, tol = 0): boolean {
  const l = toRectLocal(r, px, py);
  return l.x >= -tol && l.y >= -tol && l.x <= r.w + tol && l.y <= r.h + tol;
}

// Squared distance from (px, py) to the segment (ax, ay)-(bx, by).
export function distSqToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

// Separating-axis test between two rotated rects (touching counts).
export function rotatedRectsIntersect(a: WorldRect, b: WorldRect): boolean {
  const ca = corners(a);
  const cb = corners(b);
  const axes: number[][] = [];
  for (const c of [ca, cb]) {
    for (let i = 0; i < 2; i++) {
      const x0 = c[i * 2];
      const y0 = c[i * 2 + 1];
      const x1 = c[((i + 1) % 4) * 2];
      const y1 = c[((i + 1) % 4) * 2 + 1];
      axes.push([-(y1 - y0), x1 - x0]);
    }
  }
  for (const [ax, ay] of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (let i = 0; i < 4; i++) {
      const pa = ca[i * 2] * ax + ca[i * 2 + 1] * ay;
      const pb = cb[i * 2] * ax + cb[i * 2 + 1] * ay;
      if (pa < minA) minA = pa;
      if (pa > maxA) maxA = pa;
      if (pb < minB) minB = pb;
      if (pb > maxB) maxB = pb;
    }
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

// True when `box` intersects the (possibly rotated) rect.
export function boxIntersectsRotatedRect(box: Box, r: WorldRect): boolean {
  return rotatedRectsIntersect(
    { x: box.minX, y: box.minY, w: box.maxX - box.minX, h: box.maxY - box.minY, rot: 0 },
    r,
  );
}

// True when the (possibly rotated) rect lies entirely inside `box`.
export function rotatedRectInsideBox(r: WorldRect, box: Box): boolean {
  const c = corners(r);
  for (let i = 0; i < 4; i++) {
    const x = c[i * 2];
    const y = c[i * 2 + 1];
    if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) return false;
  }
  return true;
}
