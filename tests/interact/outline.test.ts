import { describe, expect, it } from 'vitest';
import { outlineOf, outlinePoints } from '../../src/interact/outline';

const CAM = { tx: 0, ty: 0, scale: 1 };
const rect = { x: 0, y: 0, w: 100, h: 60, rot: 0 };

const bounds = (pts: number[]) => {
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

describe('outlineOf', () => {
  it('keeps the rect and the element radius', () => {
    expect(outlineOf({ radius: 8 }, rect)).toEqual({ ...rect, radius: 8 });
  });

  it('clamps the radius to half the short side and to zero', () => {
    expect(outlineOf({ radius: 500 }, rect).radius).toBe(30);
    expect(outlineOf({ radius: -4 }, rect).radius).toBe(0);
  });
});

describe('outlinePoints', () => {
  it('is the four screen-space corners for a square outline', () => {
    const pts = outlinePoints({ ...rect, radius: 0 }, { tx: 10, ty: 20, scale: 2 }, 0);
    expect(pts).toEqual([10, 20, 210, 20, 210, 140, 10, 140]);
  });

  it('is square when the radius is absent', () => {
    expect(outlinePoints(rect, CAM)).toHaveLength(8);
  });

  it('turns into a polygon with rounded corners that stays inside the box', () => {
    const pts = outlinePoints({ ...rect, radius: 12 }, CAM);
    expect(pts.length).toBeGreaterThan(8);
    expect(pts.length % 2).toBe(0);
    expect(bounds(pts)).toEqual({ x0: 0, x1: 100, y0: 0, y1: 60 });
    // The sharp corner (0, 0) is cut.
    for (let i = 0; i < pts.length; i += 2) {
      expect(pts[i] + pts[i + 1]).toBeGreaterThan(1);
    }
  });

  it('scales the radius with the zoom', () => {
    const cut = (scale: number): number => {
      const pts = outlinePoints({ ...rect, radius: 10 }, { tx: 0, ty: 0, scale });
      // Distance from the sharp top-left corner to the nearest vertex.
      return Math.min(...pts.map((_, i) => (i % 2 ? Infinity : Math.hypot(pts[i], pts[i + 1]))));
    };
    expect(cut(2)).toBeGreaterThan(cut(1));
  });

  it('grows by the offset on every side', () => {
    const pts = outlinePoints({ ...rect, radius: 0 }, CAM, 3);
    expect(bounds(pts)).toEqual({ x0: -3, x1: 103, y0: -3, y1: 63 });
    // The offset is screen px: it does not scale with the camera.
    const z = outlinePoints({ ...rect, radius: 0 }, { tx: 0, ty: 0, scale: 2 }, 3);
    expect(bounds(z)).toEqual({ x0: -3, x1: 203, y0: -3, y1: 123 });
  });

  it('a negative offset shrinks it, and collapses to nothing when it eats the box', () => {
    expect(bounds(outlinePoints({ ...rect, radius: 0 }, CAM, -5))).toEqual({
      x0: 5,
      x1: 95,
      y0: 5,
      y1: 55,
    });
    expect(outlinePoints({ ...rect, radius: 0 }, CAM, -40)).toEqual([]);
  });

  it('rotates about the rect centre', () => {
    const pts = outlinePoints({ x: 0, y: 0, w: 100, h: 20, rot: 90, radius: 0 }, CAM);
    // Centre (50, 10); a quarter turn clockwise sends the top-left to the top-right.
    expect(pts[0]).toBeCloseTo(60);
    expect(pts[1]).toBeCloseTo(-40);
    const b = bounds(pts);
    expect(b.x1 - b.x0).toBeCloseTo(20);
    expect(b.y1 - b.y0).toBeCloseTo(100);
  });

  it('reuses and clears the output array', () => {
    const out = [1, 2, 3];
    expect(outlinePoints(rect, CAM, 0, out)).toBe(out);
    expect(out).toHaveLength(8);
  });
});
