// Where the video overlay lands: the <video> is laid out at the card's world size and placed by its
// transform alone, so the four corners of that element, pushed through the transform, must be the four
// corners of the card on screen (what the renderer draws), whatever the zoom,
// the pan and the rotation. The expected corners come from the library's own `corners()` + the camera,
// not from the function under test.
import { describe, expect, it } from 'vitest';
import type { Camera } from '../../src/math';
import { corners, DEG } from '../../src/interact/geometry';
import { videoPlacement, type VideoRect } from '../../src/video/videoGeometry';

const CAMERAS: Camera[] = [
  { tx: 0, ty: 0, scale: 1 },
  { tx: 640, ty: 400, scale: 0.5 },
  { tx: -1234.5, ty: 87.25, scale: 2 },
  { tx: 311, ty: -90, scale: 0.0625 },
  { tx: 12, ty: 34, scale: 7.5 },
];
const RECTS: VideoRect[] = [
  { x: 0, y: 0, w: 360, h: 640 }, // portrait 9:16
  { x: 100, y: 40, w: 640, h: 360, rot: 0 }, // landscape 16:9
  { x: -500.5, y: -300.25, w: 1744, h: 3100, rot: 0 }, // wider than any viewport when zoomed out
  { x: 120, y: 80, w: 360, h: 640, rot: 20 },
  { x: -80, y: 900, w: 640, h: 360, rot: -37.5 },
  { x: 10, y: 10, w: 248, h: 310, rot: 90 },
  { x: 10, y: 10, w: 248, h: 310, rot: 180 },
  { x: 10, y: 10, w: 248, h: 310, rot: 359.9 },
];

// The element's local corners [0,0] [w,0] [w,h] [0,h], through `translate(x, y) scale(s) rotate(r)` with
// the transform origin at 0 0, the way the browser composes them.
function throughTransform(
  p: { x: number; y: number; scale: number; rot: number },
  r: VideoRect,
): number[] {
  const a = p.rot * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const out: number[] = [];
  for (const [lx, ly] of [
    [0, 0],
    [r.w, 0],
    [r.w, r.h],
    [0, r.h],
  ]) {
    out.push(p.x + p.scale * (lx * c - ly * s), p.y + p.scale * (lx * s + ly * c));
  }
  return out;
}

describe('videoPlacement', () => {
  it('is translate + scale for an unrotated card: the box on screen', () => {
    const p = videoPlacement({ x: 100, y: 40, w: 248, h: 310 }, { tx: 30, ty: -10, scale: 2 });
    expect(p.transform).toBe('translate(230px, 70px) scale(2)');
    expect([p.x, p.y, p.scale, p.rot]).toEqual([230, 70, 2, 0]);
    // rot: 0 and a missing rot are the same card.
    expect(
      videoPlacement({ x: 100, y: 40, w: 248, h: 310, rot: 0 }, { tx: 30, ty: -10, scale: 2 }),
    ).toEqual(p);
  });

  it('puts the box centre where the card centre is, rotated or not', () => {
    for (const cam of CAMERAS) {
      for (const r of RECTS) {
        const p = videoPlacement(r, cam);
        expect(p.cx).toBeCloseTo(cam.tx + (r.x + r.w / 2) * cam.scale, 2);
        expect(p.cy).toBeCloseTo(cam.ty + (r.y + r.h / 2) * cam.scale, 2);
      }
    }
  });

  it('lands the four corners of the element on the four corners of the card, on screen', () => {
    for (const cam of CAMERAS) {
      for (const r of RECTS) {
        const p = videoPlacement(r, cam);
        const got = throughTransform(p, r);
        const want = corners({ x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot ?? 0 }).map((v, i) =>
          i % 2 === 0 ? cam.tx + v * cam.scale : cam.ty + v * cam.scale,
        );
        for (let i = 0; i < 8; i++) {
          // Sub-pixel: the placement rounds to 1/1000 px.
          expect(Math.abs(got[i] - want[i])).toBeLessThan(0.01 + Math.abs(r.w * cam.scale) * 1e-5);
        }
      }
    }
  });

  it('a card turned 90 degrees keeps its centre and swaps its screen extent', () => {
    const p = videoPlacement({ x: 0, y: 0, w: 100, h: 200, rot: 90 }, { tx: 0, ty: 0, scale: 1 });
    // The centre (50, 100) stays; the 100 x 200 box now spans x 0..200, y 50..150.
    expect(p.transform).toBe('translate(150px, 50px) scale(1) rotate(90deg)');
    expect([p.cx, p.cy]).toEqual([50, 100]);
  });

  it('writes the same transform for the same input (stable strings, so nothing is rewritten)', () => {
    const cam = { tx: 1 / 3, ty: 2 / 3, scale: 1 / 7 };
    const r = { x: 1 / 3, y: 2 / 7, w: 100, h: 50, rot: 12.3456789012 };
    expect(videoPlacement(r, cam).transform).toBe(videoPlacement({ ...r }, { ...cam }).transform);
    expect(videoPlacement(r, cam).transform).toMatch(
      /^translate\(-?\d+(\.\d{1,3})?px, -?\d+(\.\d{1,3})?px\) scale\(0\.142857\) rotate\(12\.345679deg\)$/,
    );
  });

  it('pan and zoom move the placement the way the WebGL world does', () => {
    const r: VideoRect = { x: 200, y: 100, w: 360, h: 640, rot: 15 };
    const a = videoPlacement(r, { tx: 0, ty: 0, scale: 1 });
    const b = videoPlacement(r, { tx: 50, ty: -20, scale: 1 });
    expect(b.x - a.x).toBeCloseTo(50, 3);
    expect(b.y - a.y).toBeCloseTo(-20, 3);
    const c = videoPlacement(r, { tx: 0, ty: 0, scale: 2 });
    expect(c.x).toBeCloseTo(a.x * 2, 2);
    expect(c.y).toBeCloseTo(a.y * 2, 2);
    expect(c.scale).toBe(2);
  });
});
