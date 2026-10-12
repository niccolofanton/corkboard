// The outline of an element: the rounded rect the interaction overlay strokes for the hover and the
// selection. Pure, so the shape is tested without Pixi.
//
// An outline follows the corner radius its element is painted with instead of the square box, and
// `outlinePoints` grows it by a screen-px offset the way a CSS outline-offset does: the outer radius is
// `r + offset`.
import type { Camera } from '../math';
import type { Element } from '../types';
import { DEG, type WorldRect } from './geometry';

// A world rect plus the corner radius to draw it with.
export interface OutlineRect extends WorldRect {
  // World px; 0 / absent = square corners.
  radius?: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// The outline of `el` at `rect` (its world rect, or the live preview of it while it is dragged).
export function outlineOf(el: Pick<Element, 'radius'>, rect: WorldRect): OutlineRect {
  return { ...rect, radius: clamp(el.radius, 0, Math.min(rect.w, rect.h) / 2) };
}

// Segments per quarter arc: enough that the polygon is smooth at the screen radius, few for a small one.
function quarterSteps(rs: number): number {
  return clamp(Math.ceil(rs / 2), 3, 14);
}

// The outline as a closed screen-space polygon [x0, y0, x1, y1, ...], clockwise from the top-left, grown
// by `offset` screen px on every side (negative shrinks). The radius scales with the camera and gains the
// offset, so the outline stays concentric with the element's own corners.
export function outlinePoints(
  r: OutlineRect,
  cam: Camera,
  offset = 0,
  out: number[] = [],
): number[] {
  out.length = 0;
  const hw = (r.w * cam.scale) / 2 + offset;
  const hh = (r.h * cam.scale) / 2 + offset;
  if (hw <= 0 || hh <= 0) return out;
  const cx = cam.tx + (r.x + r.w / 2) * cam.scale;
  const cy = cam.ty + (r.y + r.h / 2) * cam.scale;
  const a = r.rot * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const push = (lx: number, ly: number): void => {
    out.push(cx + lx * c - ly * s, cy + lx * s + ly * c);
  };

  const rs = clamp((r.radius ?? 0) * cam.scale + offset, 0, Math.min(hw, hh));
  if (rs < 0.5) {
    push(-hw, -hh);
    push(hw, -hh);
    push(hw, hh);
    push(-hw, hh);
    return out;
  }
  const steps = quarterSteps(rs);
  // Corner centres and the angle each quarter arc starts at: top-right, bottom-right, bottom-left, top-left.
  const arcs: ReadonlyArray<readonly [number, number, number]> = [
    [hw - rs, -(hh - rs), -Math.PI / 2],
    [hw - rs, hh - rs, 0],
    [-(hw - rs), hh - rs, Math.PI / 2],
    [-(hw - rs), -(hh - rs), Math.PI],
  ];
  for (const [ax, ay, a0] of arcs) {
    for (let i = 0; i <= steps; i++) {
      const t = a0 + (i / steps) * (Math.PI / 2);
      push(ax + rs * Math.cos(t), ay + rs * Math.sin(t));
    }
  }
  return out;
}
