import { describe, expect, it } from 'vitest';
import { hitTest, hitTestAll } from '../../src/interact/hitTest';
import { el, readerOf } from './fixtures';

describe('hitTest', () => {
  it('returns null on empty canvas', () => {
    const r = readerOf([el('a')]);
    expect(hitTest(r, 500, 500, { zoom: 1 })).toBeNull();
  });

  it('the topmost element by rank wins, whatever the search order', () => {
    const r = readerOf([el('bottom'), el('middle', { x: 20 }), el('top', { x: 40 })]);
    expect(hitTest(r, 60, 50, { zoom: 1 })?.id).toBe('top');
    // Only the lower two cover this point.
    expect(hitTest(r, 30, 50, { zoom: 1 })?.id).toBe('middle');
    expect(hitTest(r, 5, 50, { zoom: 1 })?.id).toBe('bottom');
  });

  it('tests the real rotated rect, not its bounding box', () => {
    // 200 x 20 at the origin, rotated 90 degrees: a vertical bar around x = 100, y from -90 to 110.
    const r = readerOf([el('bar', { w: 200, h: 20, rot: 90 })]);
    expect(hitTest(r, 100, 100, { zoom: 1, tolerancePx: 0 })?.id).toBe('bar');
    // Inside the unrotated rect but outside the rotated one.
    expect(hitTest(r, 10, 10, { zoom: 1, tolerancePx: 0 })).toBeNull();
    // Inside the AABB, outside the rect.
    expect(hitTest(r, 60, 100, { zoom: 1, tolerancePx: 0 })).toBeNull();
  });

  it('the tolerance is in screen px, so it shrinks in world units as the zoom grows', () => {
    const r = readerOf([el('a')]);
    // 3 world px right of the edge.
    expect(hitTest(r, 103, 50, { zoom: 1, tolerancePx: 4 })?.id).toBe('a');
    expect(hitTest(r, 103, 50, { zoom: 2, tolerancePx: 4 })).toBeNull();
    expect(hitTest(r, 101.5, 50, { zoom: 2, tolerancePx: 4 })?.id).toBe('a');
    // Zoomed out the same 4 px reach further in the world.
    expect(hitTest(r, 120, 50, { zoom: 0.1, tolerancePx: 4 })?.id).toBe('a');
  });

  it('uses 4 px by default and falls back to zoom 1 for a bad zoom', () => {
    const r = readerOf([el('a')]);
    expect(hitTest(r, 103.5, 50, { zoom: 1 })?.id).toBe('a');
    expect(hitTest(r, 104.5, 50, { zoom: 1 })).toBeNull();
    expect(hitTest(r, 103.5, 50, { zoom: 0 })?.id).toBe('a');
    expect(hitTest(r, 103.5, 50, { zoom: NaN })?.id).toBe('a');
  });

  it('a locked element is hit unless skipLocked is set', () => {
    const r = readerOf([el('under'), el('locked', { locked: true })]);
    expect(hitTest(r, 50, 50, { zoom: 1 })?.id).toBe('locked');
    expect(hitTest(r, 50, 50, { zoom: 1, skipLocked: true })?.id).toBe('under');
  });

  it('honours the filter', () => {
    const r = readerOf([el('img'), el('vid', { kind: 'video' })]);
    expect(hitTest(r, 50, 50, { zoom: 1 })?.id).toBe('vid');
    expect(hitTest(r, 50, 50, { zoom: 1, filter: (e) => e.kind === 'image' })?.id).toBe('img');
  });
});

describe('hitTestAll', () => {
  it('lists every element under the point, top to bottom', () => {
    const r = readerOf([el('a'), el('b', { x: 10 }), el('c', { x: 500 }), el('d', { x: 20 })]);
    const out = hitTestAll(r, 50, 50, { zoom: 1 });
    expect(out.map((e) => e.id)).toEqual(['d', 'b', 'a']);
  });

  it('clears and returns the caller\'s array', () => {
    const r = readerOf([el('a')]);
    const out = [el('stale')];
    expect(hitTestAll(r, 50, 50, { zoom: 1 }, out)).toBe(out);
    expect(out.map((e) => e.id)).toEqual(['a']);
    expect(hitTestAll(r, 900, 900, { zoom: 1 }, out)).toEqual([]);
  });

  it('applies skipLocked and the filter', () => {
    const r = readerOf([el('a'), el('b', { locked: true }), el('c', { kind: 'video' })]);
    expect(hitTestAll(r, 50, 50, { zoom: 1, skipLocked: true }).map((e) => e.id)).toEqual(['c', 'a']);
    expect(
      hitTestAll(r, 50, 50, { zoom: 1, filter: (e) => e.kind === 'image' }).map((e) => e.id),
    ).toEqual(['b', 'a']);
  });
});
