import { describe, expect, it } from 'vitest';
import { align, distribute, equalWidth, type AlignMode } from '../../src/layout';
import type { Aabb } from '../../src/interact/geometry';

const box = (minX: number, minY: number, maxX: number, maxY: number): Aabb => ({
  minX,
  minY,
  maxX,
  maxY,
});

const obj = (m: Map<string, unknown>): Record<string, unknown> => Object.fromEntries(m);

describe('align', () => {
  // Union box: x 0..250, y 0..340 (centre 125, 170).
  const items = [
    { id: 'A', box: box(0, 0, 100, 50) }, // centre (50, 25)
    { id: 'B', box: box(50, 100, 250, 200) }, // centre (150, 150)
    { id: 'C', box: box(20, 300, 80, 340) }, // centre (50, 320)
  ];
  const run = (mode: AlignMode) => obj(align(items, mode));

  it('left aligns to the union left edge and omits what is already there', () => {
    expect(run('left')).toEqual({ B: { dx: -50, dy: 0 }, C: { dx: -20, dy: 0 } });
  });

  it('right aligns to the union right edge', () => {
    expect(run('right')).toEqual({ A: { dx: 150, dy: 0 }, C: { dx: 170, dy: 0 } });
  });

  it('centerX aligns centres to the middle of the union', () => {
    expect(run('centerX')).toEqual({
      A: { dx: 75, dy: 0 },
      B: { dx: -25, dy: 0 },
      C: { dx: 75, dy: 0 },
    });
  });

  it('top aligns to the union top edge', () => {
    expect(run('top')).toEqual({ B: { dx: 0, dy: -100 }, C: { dx: 0, dy: -300 } });
  });

  it('bottom aligns to the union bottom edge', () => {
    expect(run('bottom')).toEqual({ A: { dx: 0, dy: 290 }, B: { dx: 0, dy: 140 } });
  });

  it('middleY aligns centres to the middle of the union', () => {
    expect(run('middleY')).toEqual({
      A: { dx: 0, dy: 145 },
      B: { dx: 0, dy: 20 },
      C: { dx: 0, dy: -150 },
    });
  });

  it('returns an empty map when everything is already aligned or there is one item', () => {
    const flush = [
      { id: 'a', box: box(0, 0, 10, 10) },
      { id: 'b', box: box(0, 20, 30, 40) },
    ];
    expect(align(flush, 'left').size).toBe(0);
    expect(align([flush[0]], 'right').size).toBe(0);
    expect(align([], 'top').size).toBe(0);
  });
});

describe('distribute', () => {
  // Widths 100, 30, 100, 100 over 0..600: gap = (600 - 330) / 3 = 90.
  const items = [
    { id: 'D', box: box(500, 0, 600, 10) },
    { id: 'B', box: box(120, 0, 150, 10) },
    { id: 'A', box: box(0, 0, 100, 10) },
    { id: 'C', box: box(200, 0, 300, 10) },
  ];

  it('spreads equal gaps along x, keeping the extremes, whatever the input order', () => {
    // A stays 0..100; B -> 190..220; C -> 310..410; D stays 500..600.
    const r = distribute(items, 'x');
    expect(obj(r)).toEqual({ B: { dx: 70, dy: 0 }, C: { dx: 110, dy: 0 } });
    const moved = items
      .map((it) => ({
        lo: it.box.minX + (r.get(it.id)?.dx ?? 0),
        hi: it.box.maxX + (r.get(it.id)?.dx ?? 0),
      }))
      .sort((a, b) => a.lo - b.lo);
    const gaps = [1, 2, 3].map((i) => moved[i].lo - moved[i - 1].hi);
    expect(gaps).toEqual([90, 90, 90]);
  });

  it('works on y with the same rules', () => {
    // Heights 40, 20, 40 over 0..300: gap = (300 - 100) / 2 = 100; the middle one goes 140..160.
    const col = [
      { id: 'c', box: box(0, 260, 10, 300) },
      { id: 'a', box: box(0, 0, 10, 40) },
      { id: 'b', box: box(0, 50, 10, 70) },
    ];
    expect(obj(distribute(col, 'y'))).toEqual({ b: { dx: 0, dy: 90 } });
  });

  it('needs three or more items', () => {
    expect(distribute(items.slice(0, 2), 'x').size).toBe(0);
    expect(distribute([], 'y').size).toBe(0);
  });

  it('omits items that are already evenly spaced', () => {
    const even = [
      { id: 'a', box: box(0, 0, 10, 10) },
      { id: 'b', box: box(20, 0, 30, 10) },
      { id: 'c', box: box(40, 0, 50, 10) },
    ];
    expect(distribute(even, 'x').size).toBe(0);
  });
});

describe('equalWidth', () => {
  it('sets every item to the median width and scales locked heights', () => {
    // Widths 100 / 200 / 300 -> median 200.
    const r = equalWidth([
      { id: 'a', w: 100, h: 50, aspectLocked: false },
      { id: 'b', w: 200, h: 100, aspectLocked: true },
      { id: 'c', w: 300, h: 90, aspectLocked: true },
    ]);
    // a keeps its height (not locked); b is already 200 (omitted); c scales 90 * 200 / 300 = 60.
    expect(obj(r)).toEqual({ a: { w: 200, h: 50 }, c: { w: 200, h: 60 } });
  });

  it('uses the mean of the two middle widths for an even count', () => {
    const r = equalWidth([
      { id: 'a', w: 100, h: 100, aspectLocked: true },
      { id: 'b', w: 200, h: 100, aspectLocked: true },
    ]);
    expect(obj(r)).toEqual({ a: { w: 150, h: 150 }, b: { w: 150, h: 75 } });
  });

  it('is empty for no items or items that already match', () => {
    expect(equalWidth([]).size).toBe(0);
    expect(
      equalWidth([
        { id: 'a', w: 80, h: 10, aspectLocked: true },
        { id: 'b', w: 80, h: 20, aspectLocked: false },
      ]).size,
    ).toBe(0);
  });
});
