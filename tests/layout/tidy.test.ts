import { describe, expect, it } from 'vitest';
import { tidy, type TidyItem } from '../../src/layout';

type Kind = 'card' | 'free' | 'fixed';

// An item whose AABB equals its rect (no rotation, no paint pad). A `free` item keeps its own size in
// the grid, a `fixed` one stays out of it.
function item(id: string, kind: Kind, x: number, y: number, w: number, h: number): TidyItem {
  const flags: Partial<TidyItem> =
    kind === 'free' ? { free: true } : kind === 'fixed' ? { fixed: true } : {};
  return { id, ...flags, box: { minX: x, minY: y, maxX: x + w, maxY: y + h }, w, h };
}
const card = (id: string, x: number, y: number, w = 100, h = 100): TidyItem =>
  item(id, 'card', x, y, w, h);

const pos = (r: ReturnType<typeof tidy>, id: string): [number, number] => {
  const m = r.moves.get(id);
  if (!m) throw new Error(`no move for ${id}`);
  return [m.x, m.y];
};

describe('tidy', () => {
  it('orders in reading order and packs a masonry grid', () => {
    // Six 100 x 100 cards, median height 100 -> row tolerance 50.
    //   centres: p1 50, p3 55, p2 70 (row 1: spread 20, within 50 of the row mean)
    //            p6 245, p4 250, p5 260 (row 2: 190 below row 1, so a new row)
    //   row 1 by x: p2 (0), p3 (150), p1 (300);  row 2 by x: p5 (0), p4 (200), p6 (400)
    //   n = 6, a = 1 -> c = round(sqrt(6)) = 2; W = 100 -> G = clamp(10, 12, 48) = 12.
    //   anchor = the top-left of the selection = (0, 0).
    const items = [
      card('p1', 300, 0),
      card('p2', 0, 20),
      card('p3', 150, 5),
      card('p4', 200, 200),
      card('p5', 0, 210),
      card('p6', 400, 195),
    ];
    const r = tidy(items);
    expect(r.count).toBe(6);
    expect(pos(r, 'p2')).toEqual([0, 0]);
    expect(pos(r, 'p3')).toEqual([112, 0]);
    expect(pos(r, 'p1')).toEqual([0, 112]);
    expect(pos(r, 'p5')).toEqual([112, 112]);
    expect(pos(r, 'p4')).toEqual([0, 224]);
    expect(pos(r, 'p6')).toEqual([112, 224]);
    expect(r.moves.get('p6')).toEqual({ x: 112, y: 224, w: 100, h: 100 });
    expect(r.bounds).toEqual({ minX: 0, minY: 0, maxX: 212, maxY: 324 });
  });

  it('clusters rows within half the median height and splits beyond it', () => {
    // Two 100 x 100 cards: tolerance 50. Centres 40 apart -> one row, so b (left) goes first.
    const sameRow = tidy([card('a', 300, 0), card('b', 0, 40)]);
    expect(pos(sameRow, 'b')).toEqual([0, 0]);
    expect(pos(sameRow, 'a')).toEqual([0, 112]); // n = 2, a = 1 -> 1 column
    // Centres 60 apart -> two rows, so a (the upper row) goes first despite being on the right.
    const twoRows = tidy([card('a', 300, 0), card('b', 0, 60)]);
    // Anchor: top-left of the selection = (0, 0).
    expect(pos(twoRows, 'a')).toEqual([0, 0]);
    expect(pos(twoRows, 'b')).toEqual([0, 112]);
  });

  it('is independent of the input order', () => {
    const items = [card('a', 0, 0), card('b', 150, 10), card('c', 20, 220), card('d', 160, 230)];
    const forward = tidy(items);
    const backward = tidy(items.slice().reverse());
    for (const it of items) expect(pos(backward, it.id)).toEqual(pos(forward, it.id));
  });

  it('resizes cards to the median width keeping their aspect', () => {
    // Widths 200 / 300 / 400 -> W = 300, G = 30. Heights: 100 -> 150 (aspect 0.5), 300 -> 300,
    // 800 -> 600 (aspect 2). a = mean(0.5, 1, 2) = 1.1667 -> c = round(sqrt(3.5)) = 2.
    // Centres (50, 150, 400): median height 300 -> tolerance 150, so A and B share a row.
    //   A -> col 0 (0, 0, 300 x 150); B -> col 1 (330, 0, 300 x 300);
    //   C -> col 0 (bottom 150 + 30 = 180 < 330): (0, 180, 300 x 600).
    const r = tidy([
      item('A', 'card', 0, 0, 200, 100),
      item('B', 'card', 500, 0, 300, 300),
      item('C', 'card', 1000, 0, 400, 800),
    ]);
    expect(r.moves.get('A')).toEqual({ x: 0, y: 0, w: 300, h: 150 });
    expect(r.moves.get('B')).toEqual({ x: 330, y: 0, w: 300, h: 300 });
    expect(r.moves.get('C')).toEqual({ x: 0, y: 180, w: 300, h: 600 });
    expect(r.bounds).toEqual({ minX: 0, minY: 0, maxX: 630, maxY: 780 });
  });

  it('keeps free-aspect items at their own size', () => {
    // Three cards (W = 100) and a 60 x 60 free item, all on one row: n = 4, a = 1 -> c = 2, G = 12.
    //   P1 -> col 0 (0, 0), P2 -> col 1 (112, 0), P3 -> col 0 (0, 112),
    //   the free item -> col 1 (112 < 224): (112, 112) at 60 x 60.
    const r = tidy([
      card('P1', 0, 0),
      card('P2', 200, 0),
      card('P3', 400, 0),
      item('N', 'free', 600, 0, 60, 60),
    ]);
    expect(r.moves.get('N')).toEqual({ x: 112, y: 112, w: 60, h: 60 });
    expect(r.moves.get('P3')).toEqual({ x: 0, y: 112, w: 100, h: 100 });

    const other = tidy([card('P1', 0, 0), card('P2', 200, 0), item('S', 'free', 400, 0, 160, 120)]);
    expect(other.moves.get('S')).toMatchObject({ w: 160, h: 120 });
    expect(other.count).toBe(3);
  });

  it('gives a free item wider than W a wider slot so it cannot overlap the next column', () => {
    // Cards 100 wide, one free item 300 wide on the same row; n = 4, c = 2. It lands in column 1
    // and column 1 starts after a 300 px slot: x = 300 + 12.
    const r = tidy([
      card('P1', 0, 0),
      card('P2', 200, 0),
      card('P3', 400, 0),
      item('N', 'free', 600, 0, 300, 100),
    ]);
    expect(r.moves.get('P2')).toEqual({ x: 312, y: 0, w: 100, h: 100 });
    expect(r.moves.get('N')).toEqual({ x: 312, y: 112, w: 300, h: 100 });
  });

  it('takes W from the participating items when none is a card', () => {
    const r = tidy([item('N1', 'free', 0, 0, 200, 200), item('N2', 'free', 300, 0, 200, 200)]);
    // W = 200, G = 20; n = 2, a = 1 -> 1 column.
    expect(r.moves.get('N1')).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    expect(r.moves.get('N2')).toEqual({ x: 0, y: 220, w: 200, h: 200 });
  });

  it('leaves fixed items alone and out of the computation', () => {
    const items = [
      card('p1', 100, 100),
      card('p2', 300, 100),
      item('t', 'fixed', -5000, -5000, 40, 20),
      item('s', 'fixed', -4000, 9000, 500, 10),
    ];
    const r = tidy(items);
    expect([...r.moves.keys()].sort()).toEqual(['p1', 'p2']);
    expect(r.count).toBe(2);
    // The anchor is the top-left of what moves, not of the far-away fixed items.
    expect(pos(r, 'p1')).toEqual([100, 100]);
    expect(pos(r, 'p2')).toEqual([100, 212]);
  });

  it('anchors at the selection top-left by default and at opts.anchor when given', () => {
    const items = [card('a', 500, 300), card('b', 700, 320)];
    const def = tidy(items);
    expect(pos(def, 'a')).toEqual([500, 300]);
    expect(pos(def, 'b')).toEqual([500, 412]);
    const custom = tidy(items, { anchor: { x: 10, y: 20 } });
    expect(pos(custom, 'a')).toEqual([10, 20]);
    expect(pos(custom, 'b')).toEqual([10, 132]);
    expect(custom.bounds).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 232 });
  });

  it('does nothing with fewer than two participating items', () => {
    expect(tidy([]).count).toBe(0);
    expect(tidy([]).moves.size).toBe(0);
    const one = tidy([card('a', 5, 6)]);
    expect(one.moves.size).toBe(0);
    expect(one.count).toBe(0);
    const oneAndFixed = tidy([card('a', 5, 6), item('t', 'fixed', 0, 0, 10, 10)]);
    expect(oneAndFixed.moves.size).toBe(0);
  });

  it('caps the grid at 10 columns', () => {
    const items = Array.from({ length: 120 }, (_, i) =>
      card(`c${i}`, (i % 12) * 150, Math.floor(i / 12) * 150),
    );
    const r = tidy(items);
    // n = 120, a = 1 -> sqrt(120) = 10.95 -> 11 -> capped at 10 columns of 100 + 12.
    const xs = new Set([...r.moves.values()].map((m) => m.x));
    expect(xs.size).toBe(10);
    expect(r.bounds.maxX - r.bounds.minX).toBe(10 * 100 + 9 * 12);
  });

  it('uses the AABB for reading order but the element size for the grid', () => {
    // A rotated card has a bigger AABB than its rect; its slot is still w x h.
    const rotated: TidyItem = {
      id: 'r',
      box: { minX: -20, minY: -20, maxX: 120, maxY: 120 },
      w: 100,
      h: 100,
    };
    const r = tidy([rotated, card('b', 300, 0)]);
    expect(r.moves.get('r')).toEqual({ x: -20, y: -20, w: 100, h: 100 }); // anchored at the AABB corner
  });
});
