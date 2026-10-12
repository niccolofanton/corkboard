import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_FALLBACK_ASPECT,
  PLACEMENT_FALLBACK_WIDTH,
  masonry,
  placementColumns,
  placementGap,
  placementWidth,
  planPlacement,
  translatePlacement,
  translatePlacementInPlace,
} from '../../src/layout';

describe('placementWidth', () => {
  it('falls back to 248 with fewer than 3 cards', () => {
    expect(PLACEMENT_FALLBACK_WIDTH).toBe(248);
    expect(placementWidth([])).toBe(248);
    expect(placementWidth([100])).toBe(248);
    expect(placementWidth([100, 900])).toBe(248);
  });

  it('is the median width from 3 cards on', () => {
    expect(placementWidth([100, 300, 200])).toBe(200);
    expect(placementWidth([500, 100, 300, 200, 400])).toBe(300);
    // Even count: the mean of the two middle widths.
    expect(placementWidth([100, 400, 200, 300])).toBe(250);
  });

  it('is not skewed by an outlier and ignores invalid widths', () => {
    expect(placementWidth([200, 200, 200, 1200])).toBe(200);
    expect(placementWidth([0, NaN, 200, 300])).toBe(248); // only 2 valid widths remain
    expect(placementWidth([0, 100, 200, 300])).toBe(200);
  });
});

describe('placementGap', () => {
  it('is a tenth of the width, rounded', () => {
    expect(placementGap(248)).toBe(25); // 24.8
    expect(placementGap(300)).toBe(30);
    expect(placementGap(400)).toBe(40);
  });

  it('clamps at both ends', () => {
    expect(placementGap(80)).toBe(12); // 8 -> 12
    expect(placementGap(120)).toBe(12);
    expect(placementGap(480)).toBe(48);
    expect(placementGap(600)).toBe(48); // 60 -> 48
  });
});

describe('placementColumns', () => {
  it('matches the spec table at mean aspect 1.25', () => {
    expect(placementColumns(1, 1.25)).toBe(1);
    expect(placementColumns(4, 1.25)).toBe(2); // sqrt(5) = 2.24
    expect(placementColumns(12, 1.25)).toBe(4); // sqrt(15) = 3.87
    expect(placementColumns(30, 1.25)).toBe(6); // sqrt(37.5) = 6.12
    expect(placementColumns(100, 1.25)).toBe(10); // sqrt(125) = 11.2 -> capped
  });

  it('never goes below 2 columns for 2 or more items', () => {
    expect(placementColumns(2, 1.25)).toBe(2); // sqrt(2.5) = 1.58
    expect(placementColumns(3, 0.5)).toBe(2); // sqrt(1.5) = 1.22 -> 1 -> 2
  });

  it('is a single row with Shift', () => {
    expect(placementColumns(4, 1.25, true)).toBe(4);
    expect(placementColumns(37, 1.25, true)).toBe(37);
    expect(placementColumns(1, 1.25, true)).toBe(1);
  });

  it('uses the fallback aspect for an unusable mean', () => {
    expect(placementColumns(12, 0)).toBe(placementColumns(12, PLACEMENT_FALLBACK_ASPECT));
    expect(placementColumns(12, NaN)).toBe(4);
  });
});

describe('masonry', () => {
  it('sends the first items to columns 0..c-1 left to right when heights are equal', () => {
    const items = Array.from({ length: 4 }, () => ({ aspect: 1 }));
    const { rects } = masonry(items, { width: 100, gap: 10, columns: 3 });
    // Column slot = 110: x = 0, 110, 220; the 4th ties again and goes back to column 0.
    expect(rects.map((r) => [r.x, r.y])).toEqual([
      [0, 0],
      [110, 0],
      [220, 0],
      [0, 110],
    ]);
  });

  it('packs into the shortest column and returns exact rects', () => {
    // width 100, gap 10, 2 columns, heights = round(100 * aspect) = 100, 200, 100, 50, 100.
    //  #0 -> col 0 (0 vs 0, leftmost):     (0, 0)     col0 next = 0 + 100 + 10 = 110
    //  #1 -> col 1 (0 < 110):              (110, 0)   col1 next = 0 + 200 + 10 = 210
    //  #2 -> col 0 (110 < 210):            (0, 110)   col0 next = 110 + 100 + 10 = 220
    //  #3 -> col 1 (210 < 220):            (110, 210) col1 next = 210 + 50 + 10 = 270
    //  #4 -> col 0 (220 < 270):            (0, 220)   col0 next = 330
    const items = [1, 2, 1, 0.5, 1].map((aspect) => ({ aspect }));
    const r = masonry(items, { width: 100, gap: 10, columns: 2 });
    expect(r.rects).toEqual([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 110, y: 0, w: 100, h: 200 },
      { x: 0, y: 110, w: 100, h: 100 },
      { x: 110, y: 210, w: 100, h: 50 },
      { x: 0, y: 220, w: 100, h: 100 },
    ]);
    // Bounds: gaps only between items. Width = 110 + 100; height = max(220 + 100, 210 + 50).
    expect(r.width).toBe(210);
    expect(r.height).toBe(320);
  });

  it('rounds heights to integers and falls back for a missing aspect', () => {
    const r = masonry([{ aspect: 1.333 }, { aspect: 0 }, { aspect: NaN }], {
      width: 100,
      gap: 10,
      columns: 3,
    });
    expect(r.rects.map((x) => x.h)).toEqual([133, 125, 125]); // 133.3 -> 133; fallback 1.25
  });

  it('keeps an explicit width left-aligned in its slot', () => {
    const r = masonry([{ aspect: 1 }, { aspect: 1, w: 60 }, { aspect: 1 }], {
      width: 100,
      gap: 10,
      columns: 2,
    });
    expect(r.rects[1]).toEqual({ x: 110, y: 0, w: 60, h: 60 });
    // The third item goes to column 1 (60 + 10 = 70 < 110) below the free item.
    expect(r.rects[2]).toEqual({ x: 110, y: 70, w: 100, h: 100 });
    expect(r.width).toBe(210);
    expect(r.height).toBe(170);
  });

  it('honours an explicit height and handles an empty list', () => {
    const r = masonry([{ aspect: 1, w: 80, h: 33.5 }], { width: 100, gap: 10, columns: 2 });
    expect(r.rects[0]).toEqual({ x: 0, y: 0, w: 80, h: 33.5 });
    expect(masonry([], { width: 100, gap: 10, columns: 3 })).toEqual({
      rects: [],
      width: 0,
      height: 0,
    });
  });
});

describe('planPlacement', () => {
  it('n = 1 with a grab anchor puts the card top-left exactly at the anchor', () => {
    const r = planPlacement({
      items: [{ aspect: 1.5 }],
      existingCardWidths: [],
      anchor: { kind: 'grab', x: 100, y: 50 },
    });
    // W = 248 (no cards), height = round(248 * 1.5) = 372.
    expect(r.width).toBe(248);
    expect(r.gap).toBe(25);
    expect(r.columns).toBe(1);
    expect(r.rects).toEqual([{ x: 100, y: 50, w: 248, h: 372 }]);
    expect(r.bounds).toEqual({ minX: 100, minY: 50, maxX: 348, maxY: 422 });
  });

  it('n >= 2 centres the block on the anchor', () => {
    // Existing cards 100 wide -> W = 100, G = clamp(10, 12, 48) = 12; 4 squares -> 2 columns.
    //  (0,0) (112,0)
    //  (0,112) (112,112)   block = 212 x 212, origin = (1000 - 106, 500 - 106)
    const r = planPlacement({
      items: Array.from({ length: 4 }, () => ({ aspect: 1 })),
      existingCardWidths: [100, 100, 100],
      anchor: { kind: 'center', x: 1000, y: 500 },
    });
    expect(r.width).toBe(100);
    expect(r.gap).toBe(12);
    expect(r.columns).toBe(2);
    expect(r.rects).toEqual([
      { x: 894, y: 394, w: 100, h: 100 },
      { x: 1006, y: 394, w: 100, h: 100 },
      { x: 894, y: 506, w: 100, h: 100 },
      { x: 1006, y: 506, w: 100, h: 100 },
    ]);
    expect(r.bounds).toEqual({ minX: 894, minY: 394, maxX: 1106, maxY: 606 });
  });

  it('Shift lays everything out in one row', () => {
    const r = planPlacement({
      items: Array.from({ length: 4 }, () => ({ aspect: 1 })),
      existingCardWidths: [100, 100, 100],
      singleRow: true,
      anchor: { kind: 'center', x: 1000, y: 500 },
    });
    // 4 columns: x = 0, 112, 224, 336 -> block 436 x 100, origin (1000 - 218, 500 - 50).
    expect(r.columns).toBe(4);
    expect(r.rects.map((x) => [x.x, x.y])).toEqual([
      [782, 450],
      [894, 450],
      [1006, 450],
      [1118, 450],
    ]);
    expect(r.bounds).toEqual({ minX: 782, minY: 450, maxX: 1218, maxY: 550 });
  });

  it('follows the column table for 12 and 100 cards', () => {
    const mk = (n: number) =>
      planPlacement({
        items: Array.from({ length: n }, () => ({ aspect: 1.25 })),
        existingCardWidths: [],
        anchor: { kind: 'center', x: 0, y: 0 },
      });
    expect(mk(12).columns).toBe(4);
    expect(mk(100).columns).toBe(10);
    // 12 cards, 4 columns of 3: each column is 3 * 310 + 2 * 25 = 980 tall, 4 * 248 + 3 * 25 wide.
    const r = mk(12);
    expect(r.bounds.maxX - r.bounds.minX).toBe(4 * 248 + 3 * 25);
    expect(r.bounds.maxY - r.bounds.minY).toBe(3 * 310 + 2 * 25);
  });

  it('keeps a free item at its own width, with room in its slot', () => {
    const r = planPlacement({
      items: [{ aspect: 1 }, { aspect: 1, w: 300 }],
      existingCardWidths: [100, 100, 100],
      anchor: { kind: 'grab', x: 0, y: 0 },
    });
    // The 300 px free item is wider than W = 100: the column slot grows so it cannot reach the next one.
    expect(r.rects[0]).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(r.rects[1]).toEqual({ x: 312, y: 0, w: 300, h: 300 });
  });

  it('an empty set yields an empty block at the anchor', () => {
    const r = planPlacement({
      items: [],
      existingCardWidths: [],
      anchor: { kind: 'center', x: 10, y: 20 },
    });
    expect(r.rects).toEqual([]);
    expect(r.bounds).toEqual({ minX: 10, minY: 20, maxX: 10, maxY: 20 });
  });
});

describe('translatePlacement', () => {
  const base = () =>
    planPlacement({
      items: [{ aspect: 1 }, { aspect: 1 }],
      existingCardWidths: [100, 100, 100],
      anchor: { kind: 'grab', x: 0, y: 0 },
    });

  it('returns a shifted copy and leaves the original alone', () => {
    const a = base();
    const b = translatePlacement(a, 10, -5);
    expect(b.rects[0]).toEqual({ x: 10, y: -5, w: 100, h: 100 });
    expect(b.bounds).toEqual({
      minX: 10,
      minY: -5,
      maxX: 10 + a.bounds.maxX,
      maxY: -5 + a.bounds.maxY,
    });
    expect(a.rects[0].x).toBe(0);
    expect(a.bounds.minX).toBe(0);
  });

  it('shifts in place without allocating new rects', () => {
    const a = base();
    const first = a.rects[0];
    const bounds = a.bounds;
    const same = translatePlacementInPlace(a, 10, -5);
    expect(same).toBe(a);
    expect(a.rects[0]).toBe(first);
    expect(a.bounds).toBe(bounds);
    expect(first).toEqual({ x: 10, y: -5, w: 100, h: 100 });
    expect(a.bounds.minX).toBe(10);
    expect(a.bounds.minY).toBe(-5);
  });
});
