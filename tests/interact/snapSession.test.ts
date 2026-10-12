import { describe, expect, it } from 'vitest';
import { SnapSession } from '../../src/interact/snap';
import { Store } from '../../src/store';
import { createElement } from '../../src/model';

const box = (x: number, y: number, w: number, h: number) => ({
  minX: x,
  minY: y,
  maxX: x + w,
  maxY: y + h,
});
const view = { x0: 0, y0: 0, x1: 1000, y1: 1000 };

describe('SnapSession', () => {
  it('snaps a moved box to the edge of a neighbour and reports guides', () => {
    const store = new Store();
    store.add([createElement({ x: 300, y: 100, w: 100, h: 100, media: { src: 'a' } }, 'a')]);
    const s = new SnapSession({ guides: true, grid: false }, 24);
    s.begin(store, view, 1, new Set());
    const r = s.move(box(100, 103, 100, 100));
    expect(r.dy).toBeCloseTo(-3);
    expect(r.guides.length).toBeGreaterThan(0);
  });

  it('snaps the top-left corner to the grid where no guide did', () => {
    const store = new Store();
    const s = new SnapSession({ guides: true, grid: true }, 24);
    s.begin(store, view, 1, new Set());
    const r = s.move(box(50, 100, 100, 100));
    expect(r.dx).toBeCloseTo(-2);
    expect(r.dy).toBeCloseTo(-4);
  });

  it('does nothing when both are off', () => {
    const store = new Store();
    store.add([createElement({ x: 300, y: 100, w: 100, h: 100, media: { src: 'a' } }, 'a')]);
    const s = new SnapSession({ guides: false, grid: false }, 24);
    s.begin(store, view, 1, new Set());
    expect(s.move(box(100, 103, 100, 100))).toMatchObject({ dx: 0, dy: 0 });
  });

  it('snaps a dragged edge to the grid on resize', () => {
    const store = new Store();
    const s = new SnapSession({ guides: false, grid: true }, 24);
    s.begin(store, view, 1, new Set());
    const r = s.resize(box(0, 0, 97, 50), { right: true });
    expect(r.dx).toBeCloseTo(-1);
    expect(r.dy).toBe(0);
  });
});
