import { describe, expect, it } from 'vitest';
import { elementsInBox, selectionBounds } from '../../src/interact/marquee';
import { el, readerOf } from './fixtures';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });

describe('elementsInBox', () => {
  const list = [
    el('a', { x: 0, y: 0 }),
    el('b', { x: 150, y: 0 }),
    el('c', { x: 400, y: 400 }),
  ];

  it('touch selects everything the box meets', () => {
    const r = readerOf(list);
    expect(elementsInBox(r, box(50, 50, 200, 80), 'touch')).toEqual(['a', 'b']);
    expect(elementsInBox(r, box(1000, 1000, 1100, 1100), 'touch')).toEqual([]);
  });

  it('contain selects only what lies wholly inside', () => {
    const r = readerOf(list);
    expect(elementsInBox(r, box(50, 50, 260, 80), 'contain')).toEqual([]);
    expect(elementsInBox(r, box(-10, -10, 260, 110), 'contain')).toEqual(['a', 'b']);
    expect(elementsInBox(r, box(-10, -10, 200, 110), 'contain')).toEqual(['a']);
  });

  it('touch uses the rotated rect, not its bounding box', () => {
    // A 45 degree diamond centred on (50, 50): its AABB corner (-20, -20) is empty space.
    const r = readerOf([el('d', { rot: 45 })]);
    expect(elementsInBox(r, box(-30, -30, -15, -15), 'touch')).toEqual([]);
    expect(elementsInBox(r, box(40, 40, 60, 60), 'touch')).toEqual(['d']);
  });

  it('contain checks the rotated corners', () => {
    const r = readerOf([el('d', { rot: 45 })]); // extends to about -20.7 .. 120.7
    expect(elementsInBox(r, box(-10, -10, 110, 110), 'contain')).toEqual([]);
    expect(elementsInBox(r, box(-25, -25, 125, 125), 'contain')).toEqual(['d']);
  });

  it('skips locked elements by default and can include them', () => {
    const r = readerOf([el('a'), el('b', { locked: true })]);
    expect(elementsInBox(r, box(0, 0, 100, 100), 'touch')).toEqual(['a']);
    expect(elementsInBox(r, box(0, 0, 100, 100), 'touch', { skipLocked: false })).toEqual(['a', 'b']);
  });

  it('applies the filter', () => {
    const r = readerOf([el('i'), el('v', { kind: 'video' })]);
    expect(elementsInBox(r, box(0, 0, 100, 100), 'touch', { filter: (e) => e.kind === 'video' })).toEqual([
      'v',
    ]);
  });

  it('returns ids in draw order, bottom first', () => {
    const r = readerOf([el('z'), el('y', { x: 10 }), el('x', { x: 20 })]);
    expect(elementsInBox(r, box(0, 0, 200, 200), 'touch')).toEqual(['z', 'y', 'x']);
  });
});

describe('selectionBounds', () => {
  it('is null when nothing resolves', () => {
    const r = readerOf([el('a')]);
    expect(selectionBounds(r, [])).toBeNull();
    expect(selectionBounds(r, ['ghost'])).toBeNull();
  });

  it('a single element reports its rotated rect and its AABB', () => {
    const r = readerOf([el('a', { x: 10, y: 20, w: 200, h: 20, rot: 90 })]);
    const b = selectionBounds(r, ['a']);
    expect(b?.rect).toEqual({ x: 10, y: 20, w: 200, h: 20, rot: 90 });
    // Centre (110, 30); rotated extent 20 x 200.
    expect(b?.box.minX).toBeCloseTo(100);
    expect(b?.box.maxX).toBeCloseTo(120);
    expect(b?.box.minY).toBeCloseTo(-70);
    expect(b?.box.maxY).toBeCloseTo(130);
  });

  it('several elements report the union and no single rect; locked ones count, missing ids do not', () => {
    const r = readerOf([el('a'), el('b', { x: 200, y: 50, locked: true })]);
    const b = selectionBounds(r, ['a', 'ghost', 'b']);
    expect(b?.rect).toBeNull();
    expect(b?.box).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 150 });
    // A missing id next to one real element still counts as a single selection.
    expect(selectionBounds(r, ['ghost', 'a'])?.rect).not.toBeNull();
  });
});
