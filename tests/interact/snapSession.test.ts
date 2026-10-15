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

  it('names the edge a symmetric resize snapped to a guide', () => {
    const store = new Store();
    store.add([createElement({ x: -103, y: 500, w: 100, h: 100, media: { src: 'a' } }, 'a')]);
    const s = new SnapSession({ guides: true, grid: false }, 24);
    s.begin(store, { x0: -500, y0: 0, x1: 1000, y1: 1000 }, 1, new Set());
    // Both edges of x are flagged: only the west one (x = 0) is within reach of the line x = -3.
    const r = s.resize(box(0, 0, 100, 100), { left: true, right: true });
    expect(r.dx).toBeCloseTo(-3);
    expect(r.edgeX).toBe('min');
    expect(r.edgeY).toBeUndefined();
  });

  it('snaps the nearer flagged edge to the grid and names it', () => {
    const store = new Store();
    const s = new SnapSession({ guides: false, grid: true }, 24);
    s.begin(store, view, 1, new Set());
    // West edge at 5 is 5 from the grid line 0; east edge at 97 is 1 from 96.
    const east = s.resize(box(5, 0, 92, 50), { left: true, right: true });
    expect(east.dx).toBeCloseTo(-1);
    expect(east.edgeX).toBe('max');
    // West edge at 1 is 1 from 0; east edge at 98 is 2 from 96.
    const west = s.resize(box(1, 0, 97, 50), { left: true, right: true });
    expect(west.dx).toBeCloseTo(-1);
    expect(west.edgeX).toBe('min');
  });
});
