import { describe, expect, it } from 'vitest';
import { autoSpot, autoSpotArea, shouldPanTo } from '../../src/layout';
import type { Aabb } from '../../src/interact/geometry';

const box = (minX: number, minY: number, maxX: number, maxY: number): Aabb => ({
  minX,
  minY,
  maxX,
  maxY,
});

const overlaps = (a: Aabb, b: Aabb): boolean =>
  a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

describe('autoSpot', () => {
  const viewport = box(0, 0, 1000, 800); // centre (500, 400)

  it('centres the block on the viewport when the board is empty', () => {
    expect(autoSpot({ w: 200, h: 100 }, viewport, [])).toEqual({ x: 400, y: 350 });
  });

  it('keeps the centre when the occupied boxes are elsewhere', () => {
    expect(autoSpot({ w: 200, h: 100 }, viewport, [box(900, 700, 950, 780)])).toEqual({
      x: 400,
      y: 350,
    });
  });

  it('finds the nearest free spot on the spiral around one blocking box', () => {
    // Block 200 x 100, step 48: candidates are (400 + 48i, 350 + 48j). The box (450..550 x 350..450)
    // blocks every top-left in the open range (250, 550) x (250, 450). Rings 0-2 are all inside it;
    // in ring 3 only j = -3 (y = 206) and j = +3 (y = 494) escape in y. Both with i = 0 are 3 steps
    // away; the top one comes first in reading order.
    const spot = autoSpot({ w: 200, h: 100 }, viewport, [box(450, 350, 550, 450)]);
    expect(spot).toEqual({ x: 400, y: 206 });
    expect(overlaps(box(spot.x, spot.y, spot.x + 200, spot.y + 100), box(450, 350, 550, 450))).toBe(
      false,
    );
  });

  it('treats touching boxes as free', () => {
    const touching = [box(600, 350, 800, 450), box(200, 350, 400, 450)]; // flush left and right
    expect(autoSpot({ w: 200, h: 100 }, viewport, touching)).toEqual({ x: 400, y: 350 });
    // One pixel of overlap blocks the centre.
    const overlapping = autoSpot({ w: 200, h: 100 }, viewport, [box(599, 350, 800, 450)]);
    expect(overlapping).not.toEqual({ x: 400, y: 350 });
  });

  it('accepts a lattice position that touches the blocker exactly', () => {
    // Viewport 960 x 960, block 96 x 96 (two steps): centre top-left (432, 432). The box equals the
    // centre block, so rings 0 and 1 are blocked; at ring 2 the candidates x = 336 and x = 528 end
    // or start exactly on the box edges (touching), and so do y = 336 / 528. Nearest: 2 steps.
    const spot = autoSpot({ w: 96, h: 96 }, box(0, 0, 960, 960), [box(432, 432, 528, 528)]);
    expect(spot).toEqual({ x: 432, y: 336 });
  });

  it('returns the centre when nothing is free within 2 viewport diagonals', () => {
    const v = box(0, 0, 100, 100); // diagonal 141.4 -> radius 282.8 -> 5 rings of 48
    const everything = box(-10_000, -10_000, 10_000, 10_000);
    expect(autoSpot({ w: 10, h: 10 }, v, [everything])).toEqual({ x: 45, y: 45 });
    // Blocked up to 4 rings (|offset| <= 192 inside the box) but free at ring 5: found there...
    expect(autoSpot({ w: 10, h: 10 }, v, [box(-150, -150, 250, 250)])).toEqual({ x: 45, y: -195 });
    // ...and a box that also covers ring 5 pushes the free spot past the bound: centre wins.
    expect(autoSpot({ w: 10, h: 10 }, v, [box(-400, -400, 500, 500)])).toEqual({ x: 45, y: 45 });
  });

  it('honours custom step and radius factor', () => {
    const v = box(0, 0, 100, 100);
    const blocker = box(0, 0, 100, 100); // centre blocked (block 10 x 10 at 45..55)
    // step 20: rings of 20 px; free as soon as |offset| >= 55 - 0... top-left must be < -10 or >= 100.
    const spot = autoSpot({ w: 10, h: 10 }, v, [blocker], { step: 20 });
    expect(overlaps(box(spot.x, spot.y, spot.x + 10, spot.y + 10), blocker)).toBe(false);
    // Radius factor 0.1 -> 14 px of search: at least one ring, nothing free -> centre.
    expect(autoSpot({ w: 10, h: 10 }, v, [blocker], { step: 20, maxRadiusFactor: 0.1 })).toEqual({
      x: 45,
      y: 45,
    });
  });

  it('ignores invalid and empty boxes', () => {
    const bad = [box(NaN, 0, 10, 10), box(Infinity, Infinity, -Infinity, -Infinity)];
    expect(autoSpot({ w: 200, h: 100 }, viewport, bad)).toEqual({ x: 400, y: 350 });
  });

  it('matches a brute-force spiral on random scenes (integer boxes, lots of touching)', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const step = 48;
    for (let scene = 0; scene < 60; scene++) {
      const vw = 480 + Math.floor(rnd() * 8) * 96;
      const vh = 480 + Math.floor(rnd() * 8) * 96;
      const v = box(0, 0, vw, vh);
      const bw = (1 + Math.floor(rnd() * 5)) * 48;
      const bh = (1 + Math.floor(rnd() * 5)) * 48;
      const occupied: Aabb[] = [];
      const count = Math.floor(rnd() * 120);
      for (let i = 0; i < count; i++) {
        const x = Math.floor(rnd() * 40 - 10) * 48;
        const y = Math.floor(rnd() * 40 - 10) * 48;
        occupied.push(
          box(x, y, x + (1 + Math.floor(rnd() * 6)) * 48, y + (1 + Math.floor(rnd() * 6)) * 48),
        );
      }
      const got = autoSpot({ w: bw, h: bh }, v, occupied);

      // Reference: rings in order, nearest in the ring, first in reading order on ties.
      const ox = vw / 2 - bw / 2;
      const oy = vh / 2 - bh / 2;
      const rings = Math.floor((2 * Math.hypot(vw, vh)) / step);
      const free = (i: number, j: number): boolean => {
        const b = box(ox + i * step, oy + j * step, ox + i * step + bw, oy + j * step + bh);
        return !occupied.some((o) => overlaps(b, o));
      };
      let expected = { x: ox, y: oy };
      search: for (let r = 0; r <= rings; r++) {
        let best: { i: number; j: number; d: number } | null = null;
        for (let j = -r; j <= r; j++) {
          for (let i = -r; i <= r; i++) {
            if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
            const d = i * i + j * j;
            if ((best === null || d < best.d) && free(i, j)) best = { i, j, d };
          }
        }
        if (best) {
          expected = { x: ox + best.i * step, y: oy + best.j * step };
          break search;
        }
      }
      expect(got).toEqual(expected);
    }
  });

  it('stays bounded and valid for a huge viewport (very low zoom)', () => {
    const v = box(0, 0, 76_800, 43_200); // 4K at zoom 0.05
    const occupied: Aabb[] = [];
    for (let i = 0; i < 200; i++)
      occupied.push(box(36_000 + i * 20, 20_000, 37_000 + i * 20, 23_000));
    const spot = autoSpot({ w: 1000, h: 1000 }, v, occupied);
    const placed = box(spot.x, spot.y, spot.x + 1000, spot.y + 1000);
    expect(occupied.some((o) => overlaps(placed, o))).toBe(false);
  });
});

describe('autoSpot with an unusable viewport', () => {
  const block = { w: 200, h: 100 };
  const finite = (p: { x: number; y: number }): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

  it('returns a finite spot for a NaN viewport instead of searching for ever', () => {
    const nan = box(NaN, NaN, NaN, NaN);
    expect(finite(autoSpot(block, nan, [box(0, 0, 10, 10)]))).toBe(true);
    expect(autoSpot(block, nan, [])).toEqual({ x: 0, y: 0 });
  });

  it('returns a finite spot for an infinite viewport, a NaN block or a NaN radius', () => {
    expect(finite(autoSpot(block, box(0, 0, Infinity, 800), []))).toBe(true);
    expect(finite(autoSpot(block, box(-Infinity, -Infinity, Infinity, Infinity), []))).toBe(true);
    expect(finite(autoSpot({ w: NaN, h: 100 }, box(0, 0, 1000, 800), []))).toBe(true);
    expect(finite(autoSpot(block, box(0, 0, 1000, 800), [], { maxRadiusFactor: NaN }))).toBe(true);
  });
});

describe('autoSpotArea', () => {
  it('is everything the search can reach: the radius around the centred block, and the block', () => {
    // Block 200 x 100 centred on (500, 400): top-left (400, 350). 2 diagonals = 2561 px: 53 rings of 48.
    const a = autoSpotArea({ w: 200, h: 100 }, box(0, 0, 1000, 800));
    expect(a).toEqual({ minX: 400 - 2544, minY: 350 - 2544, maxX: 600 + 2544, maxY: 450 + 2544 });
  });

  it('reaches the whole radius when the step grows for a huge viewport', () => {
    const v = box(0, 0, 100_000, 100_000);
    const radius = 2 * Math.hypot(100_000, 100_000);
    const a = autoSpotArea({ w: 10, h: 10 }, v, {});
    expect(a.minX).toBeCloseTo(50_000 - 5 - radius, 3);
    expect(a.maxX).toBeCloseTo(50_000 + 5 + radius, 3);
  });

  it('holds every box that can block a candidate: a free hole found at the edge of the reach', () => {
    const v = box(0, 0, 1000, 600);
    const blk = { w: 100, h: 100 };
    // Cards everywhere inside the reach but a 200 x 200 hole near the end of it.
    const all: Aabb[] = [];
    for (let x = -2200; x < 3000; x += 100) {
      for (let y = -2200; y < 2800; y += 100) {
        if (x >= 2000 && x < 2200 && y >= 200 && y < 400) continue;
        all.push(box(x, y, x + 100, y + 100));
      }
    }
    const area = autoSpotArea(blk, v);
    const inside = all.filter(
      (b) => b.minX <= area.maxX && b.maxX >= area.minX && b.minY <= area.maxY && b.maxY >= area.minY,
    );
    const spot = autoSpot(blk, v, inside);
    expect(spot.x).toBeGreaterThanOrEqual(2000);
    expect(spot.x + 100).toBeLessThanOrEqual(2200);
    expect(all.some((o) => overlaps(box(spot.x, spot.y, spot.x + 100, spot.y + 100), o))).toBe(false);
  });
});

describe('shouldPanTo', () => {
  const viewport = box(0, 0, 1000, 800);

  it('is false when the block is fully visible', () => {
    expect(shouldPanTo(box(100, 100, 300, 300), viewport)).toBe(false);
  });

  it('is false at exactly half visible and true beyond', () => {
    expect(shouldPanTo(box(900, 100, 1100, 300), viewport)).toBe(false); // 100 of 200 px inside
    expect(shouldPanTo(box(901, 100, 1101, 300), viewport)).toBe(true); // 99 of 200 px inside
  });

  it('is true when the block is off-screen', () => {
    expect(shouldPanTo(box(2000, 2000, 2200, 2200), viewport)).toBe(true);
    expect(shouldPanTo(box(1000, 0, 1200, 200), viewport)).toBe(true); // only touching
  });

  it('measures area, not width: a corner overlap is mostly outside', () => {
    // 200 x 200 block overlapping the viewport corner by 150 x 150 = 56% of its area: visible.
    expect(shouldPanTo(box(850, 650, 1050, 850), viewport)).toBe(false);
    // 100 x 100 overlap = 25%: pans.
    expect(shouldPanTo(box(900, 700, 1100, 900), viewport)).toBe(true);
  });

  it('judges a degenerate block by its centre', () => {
    expect(shouldPanTo(box(10, 10, 10, 10), viewport)).toBe(false);
    expect(shouldPanTo(box(-10, 10, -10, 10), viewport)).toBe(true);
  });
});
