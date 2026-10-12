// The iframe wrapper is laid out at (a clamp of) the card's world size and placed by its transform alone:
// pushed through it, its four corners must land on the card's four corners on screen.
import { describe, expect, it } from 'vitest';
import { corners, DEG } from '../../src/interact/geometry';
import type { Camera } from '../../src/math';
import { embedPlacement, MAX_LAYOUT_PX } from '../../src/embed/geometry';
import type { EmbedResolution } from '../../src/types';

const CAMERAS: Camera[] = [
  { tx: 0, ty: 0, scale: 1 },
  { tx: 640, ty: 400, scale: 0.5 },
  { tx: -1234.5, ty: 87.25, scale: 2 },
  { tx: 12, ty: 34, scale: 3.5 },
];
const RECTS = [
  { x: 0, y: 0, w: 400, h: 225, rot: 0 },
  { x: 100, y: 40, w: 640, h: 360, rot: 20 },
  { x: -80, y: 900, w: 480, h: 200, rot: -37.5 },
  { x: 10, y: 10, w: 400, h: 250, rot: 90 },
  { x: 0, y: 0, w: 5000, h: 3000, rot: 0 }, // beyond the layout cap
  { x: 5, y: 7, w: 1200, h: 6000, rot: 33 },
];

function viaTransform(t: string, w: number, h: number): number[] {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)(?: rotate\(([-\d.e]+)deg\))?/.exec(t);
  if (!m) throw new Error(`unparsed transform ${t}`);
  const [tx, ty, s, r] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
  const a = r * DEG;
  const out: number[] = [];
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    out.push(tx + s * (x * Math.cos(a) - y * Math.sin(a)), ty + s * (x * Math.sin(a) + y * Math.cos(a)));
  }
  return out;
}

describe('embedPlacement', () => {
  for (const res of ['720p', '1080p', 'native'] as EmbedResolution[]) for (const cam of CAMERAS) {
    for (const r of RECTS) {
      it(`covers the card: ${res}, scale ${cam.scale}, ${r.w}x${r.h}, rot ${r.rot}`, () => {
        const p = embedPlacement(r, cam, res);
        const got = viaTransform(p.transform, p.width, p.height);
        const want = corners(r).map((v, i) => (i % 2 === 0 ? cam.tx + v * cam.scale : cam.ty + v * cam.scale));
        got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 1));
      });
    }
  }

  it('lays out a virtual 720p / 1080p screen with the card aspect', () => {
    const cam = { tx: 0, ty: 0, scale: 1 };
    expect(embedPlacement({ x: 0, y: 0, w: 400, h: 225 }, cam)).toMatchObject({ width: 1280, height: 720 });
    expect(embedPlacement({ x: 0, y: 0, w: 400, h: 225 }, cam, '1080p')).toMatchObject({ width: 1920, height: 1080 });
    expect(embedPlacement({ x: 0, y: 0, w: 300, h: 600 }, cam, '720p')).toMatchObject({ width: 720, height: 1440 });
    expect(embedPlacement({ x: 0, y: 0, w: 400, h: 400 }, cam, 540)).toMatchObject({ width: 540, height: 540 });
  });

  it('lays out at world size for native, and below the cap past it', () => {
    const cam = { tx: 0, ty: 0, scale: 1 };
    expect(embedPlacement({ x: 0, y: 0, w: 400, h: 225 }, cam, 'native')).toMatchObject({ width: 400, height: 225 });
    const tall = embedPlacement({ x: 0, y: 0, w: 100, h: 1000 }, cam, '1080p');
    expect(tall.height).toBeLessThanOrEqual(MAX_LAYOUT_PX);
    expect(tall.height / tall.width).toBeCloseTo(10);
    const big = embedPlacement({ x: 0, y: 0, w: 8192, h: 4096 }, cam, 'native');
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(MAX_LAYOUT_PX);
    expect(big.width / big.height).toBeCloseTo(2);
  });

  it('puts the top-right corner where the Done button hangs', () => {
    const cam = { tx: 50, ty: 20, scale: 2 };
    const r = { x: 10, y: 10, w: 100, h: 60, rot: 0 };
    const p = embedPlacement(r, cam);
    expect(p.topRightX).toBeCloseTo(50 + 110 * 2);
    expect(p.topRightY).toBeCloseTo(20 + 10 * 2);
    const q = embedPlacement({ ...r, rot: 90 }, cam);
    const c = corners({ ...r, rot: 90 });
    expect(q.topRightX).toBeCloseTo(cam.tx + c[2] * cam.scale, 1);
    expect(q.topRightY).toBeCloseTo(cam.ty + c[3] * cam.scale, 1);
  });
});
