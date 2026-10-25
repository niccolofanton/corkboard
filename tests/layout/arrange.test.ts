// The arrange operations on a realistic selection: portrait and landscape covers, rotated cards and
// free-aspect items. Whatever the operation, the result must never put two of the selected boxes on top
// of each other, and must keep the gap between them.
import { describe, expect, it } from 'vitest';
import {
  align,
  arrangeGap,
  distribute,
  equalWidth,
  placementGap,
  separate,
  tidy,
  type AlignMode,
  type TidyItem,
} from '../../src/layout';
import { boxCx, boxCy, rotatedExtent, type Aabb } from '../../src/interact/geometry';
import { median } from '../../src/layout/stats';

// Height / width of the covers a mixed library has.
const ASPECTS = [1.25, 0.75, 1, 1.5, 0.66, 1.33, 1.78, 0.56];
const WIDTHS = [248, 248, 320, 200, 248, 280, 220, 248];

interface Item extends TidyItem {
  box: Aabb;
}

// A card at (x, y) as a store would hold it; its AABB is what a rotation makes of the box.
function card(i: number, x: number, y: number, rot = 0, w = WIDTHS[i % WIDTHS.length]): Item {
  const k = i % ASPECTS.length;
  const h = Math.round(w * ASPECTS[k]);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const e = rotatedExtent(w, h, rot);
  return {
    id: `c${i}`,
    w,
    h,
    box: { minX: cx - e.w / 2, minY: cy - e.h / 2, maxX: cx + e.w / 2, maxY: cy + e.h / 2 },
  };
}

// A free-aspect item (it keeps its own size in the grid).
function rectItem(id: string, x: number, y: number, w: number, h: number): Item {
  return { id, free: true, w, h, box: { minX: x, minY: y, maxX: x + w, maxY: y + h } };
}

// Eight cards of mixed aspect, scattered with plenty of overlap; two are rotated.
function scattered(): Item[] {
  return [
    card(0, 0, 0),
    card(1, 120, 40),
    card(2, 260, 10, 12),
    card(3, 90, 300),
    card(4, 600, 20),
    card(5, 640, 330, -20),
    card(6, 80, 700, 90),
    card(7, 400, 360),
  ];
}

// Two boxes overlap when they are closer than `gap` on both axes.
function overlaps(a: Aabb, b: Aabb, gap = 0): boolean {
  return (
    a.minX < b.maxX + gap - 1e-6 &&
    b.minX < a.maxX + gap - 1e-6 &&
    a.minY < b.maxY + gap - 1e-6 &&
    b.minY < a.maxY + gap - 1e-6
  );
}

function crossings(boxes: Aabb[], gap = 0): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++)
      if (overlaps(boxes[i], boxes[j], gap)) out.push([i, j]);
  }
  return out;
}

const moved = (
  items: readonly { id: string; box: Aabb }[],
  d: Map<string, { dx: number; dy: number }>,
): Aabb[] =>
  items.map((it) => {
    const m = d.get(it.id) ?? { dx: 0, dy: 0 };
    return {
      minX: it.box.minX + m.dx,
      minY: it.box.minY + m.dy,
      maxX: it.box.maxX + m.dx,
      maxY: it.box.maxY + m.dy,
    };
  });

const MODES: AlignMode[] = ['left', 'centerX', 'right', 'top', 'middleY', 'bottom'];

describe('tidy on a realistic selection', () => {
  it('never overlaps and keeps the gap between mixed aspects and rotations', () => {
    const items = scattered();
    const r = tidy(items);
    const rects = items.map((it) => {
      const m = r.moves.get(it.id)!;
      return { minX: m.x, minY: m.y, maxX: m.x + m.w, maxY: m.y + m.h };
    });
    // The gap of the median card width (W of the grid).
    const gap = placementGap(median(items.map((it) => it.w)));
    expect(crossings(rects, 0)).toEqual([]);
    expect(crossings(rects, gap)).toEqual([]);
  });

  it('never overlaps with free-aspect and wide items mixed in', () => {
    const items: Item[] = [
      ...scattered().slice(0, 6),
      rectItem('n1', 50, 60, 180, 180),
      rectItem('n2', 700, 700, 340, 120),
      rectItem('s1', 300, 800, 500, 90),
      rectItem('s2', 20, 900, 90, 300),
    ];
    const r = tidy(items);
    const rects = [...r.moves.values()].map((m) => ({
      minX: m.x,
      minY: m.y,
      maxX: m.x + m.w,
      maxY: m.y + m.h,
    }));
    expect(rects).toHaveLength(items.length);
    expect(crossings(rects, 0)).toEqual([]);
  });

  it('never overlaps whatever the mix (seeded sweep)', () => {
    let s = 12345;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let round = 0; round < 60; round++) {
      const n = 2 + Math.floor(rnd() * 22);
      const items: Item[] = [];
      for (let i = 0; i < n; i++) {
        const x = rnd() * 1500;
        const y = rnd() * 1500;
        if (rnd() < 0.2) {
          items.push(rectItem(`n${i}`, x, y, 60 + rnd() * 400, 60 + rnd() * 400));
        } else {
          items.push(card(i, x, y, rnd() < 0.3 ? Math.floor(rnd() * 360) : 0, 150 + rnd() * 250));
        }
      }
      const r = tidy(items);
      const rects = items.map((it) => {
        const m = r.moves.get(it.id)!;
        return { minX: m.x, minY: m.y, maxX: m.x + m.w, maxY: m.y + m.h };
      });
      expect(crossings(rects, 0)).toEqual([]);
    }
  });
});

describe('align keeps the selection apart', () => {
  const gap = 12;

  it.each(MODES)('%s lines the edge up and leaves no two boxes on each other', (mode) => {
    const items = scattered();
    const out = moved(items, align(items, mode, { gap }));
    expect(crossings(out, gap)).toEqual([]);
    const edge = (b: Aabb): number => {
      switch (mode) {
        case 'left':
          return b.minX;
        case 'centerX':
          return boxCx(b);
        case 'right':
          return b.maxX;
        case 'top':
          return b.minY;
        case 'middleY':
          return boxCy(b);
        case 'bottom':
          return b.maxY;
      }
    };
    for (const b of out) expect(edge(b)).toBeCloseTo(edge(out[0]), 6);
  });

  it('puts the aligned edge on the union box edge, as before', () => {
    const items = scattered();
    const union = Math.min(...items.map((it) => it.box.minX));
    for (const b of moved(items, align(items, 'left', { gap })))
      expect(b.minX).toBeCloseTo(union, 6);
    const top = Math.min(...items.map((it) => it.box.minY));
    for (const b of moved(items, align(items, 'top', { gap }))) expect(b.minY).toBeCloseTo(top, 6);
  });

  it('stacks a row aligned to the left into a column in the row order', () => {
    const items = [card(0, 0, 0), card(1, 400, 0), card(2, 800, 0)];
    const d = align(items, 'left', { gap });
    // Nothing moves along x but the two that were not at the left already; y grows in row order.
    const out = moved(items, d);
    expect(out[0].minY).toBe(items[0].box.minY);
    expect(out[1].minY).toBeCloseTo(out[0].maxY + gap, 6);
    expect(out[2].minY).toBeCloseTo(out[1].maxY + gap, 6);
  });

  it('does not touch what is already clear of the others', () => {
    // A column, aligned to the left: the cards are one under the other already, with room to spare.
    const items = [card(0, 0, 0), card(1, 50, 600), card(2, 200, 1200)];
    const d = align(items, 'left', { gap });
    for (const it of items) expect(d.get(it.id)?.dy ?? 0).toBe(0);
  });

  it('without a gap it is the plain alignment (the union edge, nothing else moves)', () => {
    const items = scattered();
    for (const [id, m] of align(items, 'left')) expect(m.dy, id).toBe(0);
  });

  it('keeps the gap clear of rotated cards too (their visible box is what counts)', () => {
    const items = [card(0, 0, 0, 45), card(1, 30, 40, -30), card(2, 60, 80, 90), card(3, 0, 100)];
    for (const mode of MODES) {
      expect(crossings(moved(items, align(items, mode, { gap })), gap), mode).toEqual([]);
    }
  });
});

describe('distribute keeps the selection apart', () => {
  const gap = 12;

  it.each(['x', 'y'] as const)(
    'never overlaps along %s, even when the span is too short',
    (axis) => {
      // Eight cards crowded into a space that is too small for them: the plain "equal gaps" has a negative
      // gap there, which overlaps them more.
      const items = scattered().map((it, i) => ({
        ...it,
        box: {
          minX: i * 30,
          minY: i * 30,
          maxX: i * 30 + (it.box.maxX - it.box.minX),
          maxY: i * 30 + (it.box.maxY - it.box.minY),
        },
      }));
      const out = moved(items, distribute(items, axis, { gap }));
      expect(crossings(out, gap)).toEqual([]);
    },
  );

  it('keeps equal gaps and the extremes when there is room', () => {
    const items = [card(0, 0, 0), card(1, 300, 0), card(2, 2000, 0), card(3, 4000, 0)];
    const out = moved(items, distribute(items, 'x', { gap }));
    expect(out[0].minX).toBe(items[0].box.minX);
    expect(out[3].minX).toBe(items[3].box.minX);
    const g = [1, 2, 3].map((i) => out[i].minX - out[i - 1].maxX);
    expect(g[0]).toBeCloseTo(g[1], 6);
    expect(g[1]).toBeCloseTo(g[2], 6);
    expect(g[0]).toBeGreaterThan(gap);
  });

  it('falls back to the default gap, equal everywhere, when the span is too short', () => {
    // 150 wide items over 0..390: the plain gap would be -30 (they overlap); the default gap it is.
    const wide = [0, 120, 240].map((x, i) => rectItem(`n${i}`, x, 0, 150, 100));
    const out = moved(wide, distribute(wide, 'x', { gap }));
    expect(out[0].minX).toBe(0);
    expect(out[1].minX - out[0].maxX).toBeCloseTo(gap, 6);
    expect(out[2].minX - out[1].maxX).toBeCloseTo(gap, 6);
  });

  it('is the plain equal-gap distribution without a gap option', () => {
    const items = [0, 120, 240].map((x, i) => rectItem(`n${i}`, x, 0, 150, 100));
    const out = moved(items, distribute(items, 'x'));
    // Span 0..390, widths 450: the gap is -30 (overlap): the plain behaviour keeps it.
    expect(out[1].minX - out[0].maxX).toBeCloseTo(-30, 6);
  });
});

describe('separate', () => {
  const gap = 12;

  it('moves nothing that is already clear', () => {
    const items = [rectItem('a', 0, 0, 100, 100), rectItem('b', 200, 0, 100, 100)];
    expect(separate(items, gap).size).toBe(0);
  });

  it('clears an overlap by the shorter way and keeps the first (reading order) in place', () => {
    const items = [rectItem('a', 0, 0, 100, 100), rectItem('b', 80, 10, 100, 100)];
    const d = separate(items, gap);
    expect(d.has('a')).toBe(false);
    // 20 px into a on x, 90 on y: right (32) is shorter than down (102): b goes to a.maxX + gap.
    expect(d.get('b')).toEqual({ dx: 100 + gap - 80, dy: 0 });
  });

  it('can be held to one axis', () => {
    const items = [rectItem('a', 0, 0, 100, 100), rectItem('b', 80, 10, 100, 100)];
    const d = separate(items, gap, 'y');
    expect(d.get('b')).toEqual({ dx: 0, dy: 100 + gap - 10 });
  });

  it('settles a heap of cards without any overlap left', () => {
    const items = scattered().map((it, i) => ({
      ...it,
      box: {
        minX: i * 20,
        minY: i * 15,
        maxX: i * 20 + (it.box.maxX - it.box.minX),
        maxY: i * 15 + (it.box.maxY - it.box.minY),
      },
    }));
    expect(crossings(moved(items, separate(items, gap)), gap)).toEqual([]);
  });
});

describe('equalWidth then separate', () => {
  it('a row of cards that grows to the median width no longer overlaps', () => {
    const gap = 12;
    const items = [card(0, 0, 0, 0, 200), card(1, 220, 0, 0, 300), card(2, 540, 0, 0, 400)];
    const sizes = equalWidth(
      items.map((it) => ({ id: it.id, w: it.w, h: it.h, aspectLocked: true })),
    );
    const after = items.map((it) => {
      const s = sizes.get(it.id) ?? { w: it.w, h: it.h };
      return {
        id: it.id,
        box: {
          minX: it.box.minX,
          minY: it.box.minY,
          maxX: it.box.minX + s.w,
          maxY: it.box.minY + s.h,
        },
      };
    });
    expect(crossings(after.map((a) => a.box))).not.toEqual([]);
    expect(crossings(moved(after as Item[], separate(after, gap)), gap)).toEqual([]);
  });
});

describe('arrangeGap', () => {
  it('is the default gap of the median width', () => {
    expect(arrangeGap([248, 248, 320])).toBe(placementGap(248));
    expect(arrangeGap([])).toBe(placementGap(248));
  });
});
