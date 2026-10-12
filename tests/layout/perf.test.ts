import { describe, expect, it } from 'vitest';
import {
  autoSpot,
  planPlacement,
  tidy,
  translatePlacementInPlace,
  type TidyItem,
} from '../../src/layout';
import type { Box } from '../../src/interact/geometry';

// Budgets (plan / task file): planPlacement 100 items < 2 ms, autoSpot 1,000 boxes + 100-card
// block < 5 ms. CI-style assertions use 5x; the measured median is printed for the lead.
function measure(fn: () => void, runs = 25): number {
  for (let i = 0; i < 5; i++) fn(); // warm up the JIT
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[times.length >> 1];
}

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('layout performance', () => {
  it('planPlacement of 100 items stays under budget', () => {
    const rnd = rng(1);
    const items = Array.from({ length: 100 }, () => ({ aspect: 0.6 + rnd() * 1.2 }));
    const widths = Array.from({ length: 300 }, () => 180 + rnd() * 160);
    const ms = measure(() => {
      planPlacement({ items, existingCardWidths: widths, anchor: { kind: 'center', x: 0, y: 0 } });
    });
    console.info(`planPlacement(100 items): ${ms.toFixed(3)} ms median (budget 2 ms)`);
    expect(ms).toBeLessThan(2 * 5);
  });

  it('translating a cached 100-item placement in place is trivial', () => {
    const plan = planPlacement({
      items: Array.from({ length: 100 }, () => ({ aspect: 1.25 })),
      existingCardWidths: [],
      anchor: { kind: 'center', x: 0, y: 0 },
    });
    const ms = measure(() => {
      translatePlacementInPlace(plan, 3, -2);
    });
    console.info(`translatePlacementInPlace(100 items): ${(ms * 1000).toFixed(1)} us median`);
    expect(ms).toBeLessThan(0.5);
  });

  const viewport: Box = { minX: 0, minY: 0, maxX: 1280, maxY: 800 };
  // A 100-card block at the default width: 10 columns of 248 + 25 gaps, ~2.7k world px square.
  const plan100 = planPlacement({
    items: Array.from({ length: 100 }, () => ({ aspect: 1.25 })),
    existingCardWidths: [],
    anchor: { kind: 'center', x: 0, y: 0 },
  });
  const block = {
    w: plan100.bounds.maxX - plan100.bounds.minX,
    h: plan100.bounds.maxY - plan100.bounds.minY,
  };

  function scatter(n: number, spread: number, seed: number): Box[] {
    const rnd = rng(seed);
    return Array.from({ length: n }, () => {
      const x = (rnd() - 0.5) * spread;
      const y = (rnd() - 0.5) * spread;
      return { minX: x, minY: y, maxX: x + 248, maxY: y + 310 };
    });
  }

  it('autoSpot with 1,000 occupied boxes stays under budget', () => {
    const occupied = scatter(1000, 9000, 2);
    const ms = measure(() => {
      autoSpot(block, viewport, occupied);
    });
    console.info(`autoSpot(1,000 boxes, 100-card block): ${ms.toFixed(3)} ms median (budget 5 ms)`);
    expect(ms).toBeLessThan(5 * 5);
  });

  it('autoSpot worst case (nothing free: the whole bounded search runs) stays under budget', () => {
    const occupied = scatter(1000, 9000, 3);
    occupied.push({ minX: -100_000, minY: -100_000, maxX: 100_000, maxY: 100_000 });
    // The nearest free spot is beyond 2 viewport diagonals, so the centre wins.
    expect(autoSpot(block, viewport, occupied)).toEqual({
      x: 640 - block.w / 2,
      y: 400 - block.h / 2,
    });
    const ms = measure(() => {
      autoSpot(block, viewport, occupied);
    });
    console.info(`autoSpot(1,001 boxes, fully blocked): ${ms.toFixed(3)} ms median (budget 5 ms)`);
    expect(ms).toBeLessThan(5 * 5);
  });

  it('autoSpot at very low zoom (4K viewport at 0.05) stays under budget', () => {
    const v: Box = { minX: 0, minY: 0, maxX: 76_800, maxY: 43_200 };
    const occupied = scatter(1000, 120_000, 4);
    // A wall over the centre forces the search outward (and the step to grow past 160 rings).
    occupied.push({ minX: 20_000, minY: 10_000, maxX: 57_000, maxY: 33_000 });
    const spot = autoSpot({ w: 3000, h: 3000 }, v, occupied);
    const placed = {
      minX: spot.x,
      minY: spot.y,
      maxX: spot.x + 3000,
      maxY: spot.y + 3000,
    };
    expect(
      occupied.some(
        (o) =>
          placed.minX < o.maxX &&
          placed.maxX > o.minX &&
          placed.minY < o.maxY &&
          placed.maxY > o.minY,
      ),
    ).toBe(false);
    const ms = measure(() => {
      autoSpot({ w: 3000, h: 3000 }, v, occupied);
    });
    console.info(`autoSpot(1,000 boxes, 4K at zoom 0.05): ${ms.toFixed(3)} ms median`);
    expect(ms).toBeLessThan(5 * 5);
  });

  it('tidy of 500 cards is fast enough for a click', () => {
    const rnd = rng(5);
    const items: TidyItem[] = Array.from({ length: 500 }, (_, i) => {
      const w = 200 + rnd() * 100;
      const h = w * (0.8 + rnd() * 0.8);
      const x = rnd() * 5000;
      const y = rnd() * 5000;
      return {
        id: `c${i}`,
        box: { minX: x, minY: y, maxX: x + w, maxY: y + h },
        w,
        h,
      };
    });
    const ms = measure(() => {
      tidy(items);
    }, 10);
    console.info(`tidy(500 cards): ${ms.toFixed(3)} ms median`);
    expect(ms).toBeLessThan(50);
  });
});
