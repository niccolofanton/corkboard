import { describe, expect, it } from 'vitest';
import {
  EDGE_HIT_PX,
  HANDLE_HIT_PX,
  handleAt,
  resizeCursor,
  selectionHandles,
  type SelectionHandles,
} from '../../src/interact/handles';
import { el, readerOf } from './fixtures';

const free = (id: string, over = {}) => el(id, { aspectLocked: false, ...over });

function must(s: SelectionHandles | null): SelectionHandles {
  expect(s).not.toBeNull();
  return s as SelectionHandles;
}

describe('selectionHandles', () => {
  it('is null for nothing, for unknown ids and when any element is locked', () => {
    const r = readerOf([el('a'), el('b', { locked: true })]);
    expect(selectionHandles(r, [], 1)).toBeNull();
    expect(selectionHandles(r, ['ghost'], 1)).toBeNull();
    expect(selectionHandles(r, ['b'], 1)).toBeNull();
    expect(selectionHandles(r, ['a', 'b'], 1)).toBeNull();
    expect(selectionHandles(r, ['a'], 1)).not.toBeNull();
  });

  it('puts the four corner handles on the rect, clockwise from the top-left', () => {
    const r = readerOf([el('a', { x: 10, y: 20, w: 200, h: 100 })]);
    const s = must(selectionHandles(r, ['a'], 1));
    expect(s.handles.map((h) => h.id)).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(s.handles.map((h) => [h.x, h.y])).toEqual([
      [10, 20],
      [210, 20],
      [210, 120],
      [10, 120],
    ]);
  });

  it('turns the handles with a single rotated element', () => {
    const r = readerOf([el('a', { x: 0, y: 0, w: 200, h: 100, rot: 90 })]);
    const s = must(selectionHandles(r, ['a'], 1));
    // Centre (100, 50): the top-left corner goes to the top-right.
    const nw = s.handles[0];
    expect(nw.x).toBeCloseTo(150);
    expect(nw.y).toBeCloseTo(-50);
    expect(s.rect.rot).toBe(90);
  });

  it('a multi-selection gets corner handles only, on the shared box', () => {
    const r = readerOf([free('a'), free('b', { x: 300, y: 200 })]);
    const s = must(selectionHandles(r, ['a', 'b'], 1));
    expect(s.edges).toEqual([]);
    expect(s.rect).toEqual({ x: 0, y: 0, w: 400, h: 300, rot: 0 });
    expect(s.handles).toHaveLength(4);
  });

  it('a multi-selection box wraps the rotated corners, not the unrotated rects', () => {
    const r = readerOf([el('a', { x: 0, y: 0, w: 200, h: 20, rot: 90 }), el('b', { x: 500, y: 0 })]);
    const s = must(selectionHandles(r, ['a', 'b'], 1));
    expect(s.rect.y).toBeCloseTo(-90);
  });

  it('an aspect-locked single element has no edge handles', () => {
    const r = readerOf([el('a')]);
    expect(must(selectionHandles(r, ['a'], 1)).edges).toEqual([]);
  });

  it('a free-aspect single element gets all four edges', () => {
    const r = readerOf([free('a')]);
    expect(must(selectionHandles(r, ['a'], 1)).edges.sort()).toEqual(['e', 'n', 's', 'w']);
  });

  it('drops the edges of a side that is too small on screen', () => {
    const r = readerOf([free('a', { w: 200, h: 100 })]);
    // At 0.2 zoom the height is 20 px: no e / w, but the 40 px width still allows n / s.
    expect(must(selectionHandles(r, ['a'], 0.2)).edges.sort()).toEqual(['n', 's']);
    expect(must(selectionHandles(r, ['a'], 0.05)).edges).toEqual([]);
  });

  it('cursors follow the rotation', () => {
    const r = readerOf([el('a', { rot: 90 })]);
    const s = must(selectionHandles(r, ['a'], 1));
    expect(s.handles.map((h) => h.cursor)).toEqual(s.handles.map((h) => resizeCursor(h.id, 90)));
    expect(s.handles[0].cursor).toBe('nesw-resize');
  });
});

describe('resizeCursor', () => {
  it('uses the standard cursor per handle at rest', () => {
    expect(resizeCursor('e', 0)).toBe('ew-resize');
    expect(resizeCursor('w', 0)).toBe('ew-resize');
    expect(resizeCursor('n', 0)).toBe('ns-resize');
    expect(resizeCursor('nw', 0)).toBe('nwse-resize');
    expect(resizeCursor('se', 0)).toBe('nwse-resize');
    expect(resizeCursor('ne', 0)).toBe('nesw-resize');
    expect(resizeCursor('sw', 0)).toBe('nesw-resize');
  });

  it('turns to the nearest 45 degrees', () => {
    expect(resizeCursor('e', 90)).toBe('ns-resize');
    expect(resizeCursor('e', 45)).toBe('nwse-resize');
    expect(resizeCursor('e', 20)).toBe('ew-resize');
    expect(resizeCursor('e', 25)).toBe('nwse-resize');
    expect(resizeCursor('nw', 90)).toBe('nesw-resize');
    expect(resizeCursor('e', 180)).toBe('ew-resize');
  });

  it('handles negative and large angles', () => {
    expect(resizeCursor('e', -45)).toBe('nesw-resize');
    expect(resizeCursor('e', -90)).toBe('ns-resize');
    expect(resizeCursor('e', 360 + 45)).toBe('nwse-resize');
  });
});

describe('handleAt', () => {
  const sel = (over = {}) =>
    must(selectionHandles(readerOf([free('a', { x: 0, y: 0, w: 200, h: 100, ...over })]), ['a'], 1));

  it('finds a corner within half the hit size and misses beyond it', () => {
    const s = sel();
    const half = HANDLE_HIT_PX / 2;
    expect(handleAt(s, 200 + half - 0.1, 100 + half - 0.1, 1)?.id).toBe('se');
    expect(handleAt(s, 0 - half + 0.1, 0, 1)?.id).toBe('nw');
    expect(handleAt(s, 200 + half + 3, 100 + half + 3, 1)).toBeNull();
  });

  it('scales the hit area with the zoom', () => {
    const s = sel();
    // 4 world px off the corner is 4 px at zoom 1 (hit) but 8 px at zoom 2 (miss).
    expect(handleAt(s, 204, 100, 1)?.id).toBe('se');
    expect(handleAt(s, 204, 100, 2)).toBeNull();
  });

  it('the middle of the element is not a handle', () => {
    expect(handleAt(sel(), 100, 50, 1)).toBeNull();
  });

  it('finds an edge anywhere along it, reporting the point on the edge', () => {
    const s = sel();
    const n = handleAt(s, 100, 2, 1);
    expect(n?.id).toBe('n');
    expect(n?.y).toBeCloseTo(0);
    expect(n?.x).toBeCloseTo(100);
    expect(handleAt(s, 199, 40, 1)?.id).toBe('e');
    expect(handleAt(s, 100, 100 + EDGE_HIT_PX / 2 - 0.5, 1)?.id).toBe('s');
    expect(handleAt(s, -2, 40, 1)?.id).toBe('w');
    // Past the band.
    expect(handleAt(s, 100, 20, 1)).toBeNull();
  });

  it('a corner wins over the edge it sits on', () => {
    expect(handleAt(sel(), 2, 2, 1)?.id).toBe('nw');
    expect(handleAt(sel(), 198, 2, 1)?.id).toBe('ne');
  });

  it('has no edges for an aspect-locked element or a multi-selection', () => {
    const locked = must(selectionHandles(readerOf([el('a', { w: 200, h: 100 })]), ['a'], 1));
    expect(handleAt(locked, 100, 1, 1)).toBeNull();
    const multi = must(
      selectionHandles(readerOf([free('a'), free('b', { x: 300 })]), ['a', 'b'], 1),
    );
    expect(handleAt(multi, 200, 1, 1)).toBeNull();
  });

  it('finds the edges of a rotated element in its own frame', () => {
    // 200 x 100 turned 90 degrees about (100, 50): its "n" edge becomes the vertical line x = 150.
    const s = sel({ rot: 90 });
    const h = handleAt(s, 150, 50, 1);
    expect(h?.id).toBe('n');
    expect(h?.cursor).toBe(resizeCursor('n', 90));
  });

  it('on a tiny selection the nearest handle centre wins', () => {
    const s = must(selectionHandles(readerOf([el('a', { x: 0, y: 0, w: 4, h: 4 })]), ['a'], 1));
    expect(handleAt(s, 0.5, 0.5, 1)?.id).toBe('nw');
    expect(handleAt(s, 3.5, 3.5, 1)?.id).toBe('se');
  });
});
