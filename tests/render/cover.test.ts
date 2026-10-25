import { describe, expect, it } from 'vitest';
import { coverBake, COVER_EPSILON } from '../../src/render/cover';

describe('coverBake', () => {
  it('keeps the whole source without an aspect, or with an unusable one', () => {
    const whole = { sx: 0, sy: 0, sw: 800, sh: 400, w: 800, h: 400 };
    expect(coverBake(800, 400, undefined, 2000)).toEqual(whole);
    for (const a of [0, -1, NaN, Infinity]) expect(coverBake(800, 400, a, 2000)).toEqual(whole);
  });

  it('keeps the whole source when the shapes match within the tolerance', () => {
    const r = coverBake(800, 400, 0.5 * (1 + COVER_EPSILON / 2), 2000);
    expect(r).toEqual({ sx: 0, sy: 0, sw: 800, sh: 400, w: 800, h: 400 });
  });

  it('crops the sides of a wide source for a taller card, centred', () => {
    // 800 x 400 source into a square card: a 400 x 400 window in the middle.
    expect(coverBake(800, 400, 1, 2000)).toEqual({ sx: 200, sy: 0, sw: 400, sh: 400, w: 400, h: 400 });
  });

  it('crops the top and bottom of a tall source for a wider card, centred', () => {
    // 400 x 800 source into a 2:1 card (h / w = 0.5): a 400 x 200 window.
    expect(coverBake(400, 800, 0.5, 2000)).toEqual({ sx: 0, sy: 300, sw: 400, sh: 200, w: 400, h: 200 });
  });

  it('caps the output at maxLong and never upscales', () => {
    const r = coverBake(800, 400, 1, 100);
    expect(r).toMatchObject({ sw: 400, sh: 400, w: 100, h: 100 });
    expect(coverBake(40, 20, 1, 1000)).toMatchObject({ w: 20, h: 20 });
  });

  it('produces an output with the card shape', () => {
    const r = coverBake(1000, 700, 0.3, 256);
    expect(r.h / r.w).toBeCloseTo(0.3, 1);
    expect(Math.max(r.w, r.h)).toBe(256);
  });

  it('never returns an empty output', () => {
    const r = coverBake(1000, 10, 100, 4);
    expect(r.w).toBeGreaterThanOrEqual(1);
    expect(r.h).toBeGreaterThanOrEqual(1);
  });
});
