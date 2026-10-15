import { describe, expect, it, vi } from 'vitest';
import { fromRectLocal } from '../../src/interact/geometry';
import { MAX_SIZE, MIN_SIZE, ResizeSession, type GeometryPatch, type Mods } from '../../src/interact/resize';
import type { HandleId } from '../../src/interact/handles';
import { SnapSession } from '../../src/interact/snap';
import { Store } from '../../src/store';
import { el, readerOf } from './fixtures';

const NONE: Mods = { shift: false, alt: false, ctrl: false };
const free = (id: string, over = {}) => el(id, { aspectLocked: false, ...over });

// Starts a session at `start` and returns the patch of `id` for a pointer at `to`.
function drag(
  list: ReturnType<typeof el>[],
  ids: string[],
  handle: HandleId,
  start: [number, number],
  to: [number, number],
  mods: Partial<Mods> = {},
): Map<string, GeometryPatch> {
  const s = new ResizeSession(readerOf(list), ids, handle, { x: start[0], y: start[1] });
  return s.update({ x: to[0], y: to[1] }, { ...NONE, ...mods });
}

const patchOf = (m: Map<string, GeometryPatch>, id: string): GeometryPatch => {
  const p = m.get(id);
  expect(p).toBeDefined();
  return { ...(p as GeometryPatch) };
};

describe('ResizeSession: one element', () => {
  // 200 x 100 at (100, 100): corners (100,100) .. (300,200).
  const base = (over = {}) => el('a', { x: 100, y: 100, w: 200, h: 100, ...over });

  it('starts as the identity', () => {
    const s = new ResizeSession(readerOf([base()]), ['a'], 'se', { x: 300, y: 200 });
    expect(s.affected).toEqual(['a']);
    expect(s.update({ x: 300, y: 200 }, NONE).get('a')).toEqual({ x: 100, y: 100, w: 200, h: 100 });
  });

  it('an aspect-locked corner resize keeps the aspect and anchors the opposite corner', () => {
    const p = patchOf(drag([base()], ['a'], 'se', [300, 200], [400, 250]), 'a');
    expect(p).toEqual({ x: 100, y: 100, w: 300, h: 150 });
    expect(p.w / p.h).toBeCloseTo(2);
    // The same from the opposite corner: the south-east corner (300, 200) stays.
    const q = patchOf(drag([base()], ['a'], 'nw', [100, 100], [50, 50]), 'a');
    expect(q.w / q.h).toBeCloseTo(2);
    expect(q.x + q.w).toBeCloseTo(300);
    expect(q.y + q.h).toBeCloseTo(200);
  });

  it('keeps the aspect when only one axis is dragged (the larger scale wins)', () => {
    const p = patchOf(drag([base()], ['a'], 'se', [300, 200], [400, 200]), 'a');
    expect(p).toEqual({ x: 100, y: 100, w: 300, h: 150 });
  });

  it('a free element follows the pointer on both axes', () => {
    const p = patchOf(drag([free('a', { x: 100, y: 100, w: 200, h: 100 })], ['a'], 'se', [300, 200], [400, 170]), 'a');
    expect(p).toEqual({ x: 100, y: 100, w: 300, h: 70 });
  });

  it('shift locks the aspect of a free element', () => {
    const p = patchOf(
      drag([free('a', { x: 100, y: 100, w: 200, h: 100 })], ['a'], 'se', [300, 200], [400, 170], { shift: true }),
      'a',
    );
    expect(p.w / p.h).toBeCloseTo(2);
  });

  it('an edge handle moves one side only', () => {
    const e = patchOf(drag([free('a', { x: 100, y: 100, w: 200, h: 100 })], ['a'], 'e', [300, 150], [350, 400]), 'a');
    expect(e).toEqual({ x: 100, y: 100, w: 250, h: 100 });
    const n = patchOf(drag([free('a', { x: 100, y: 100, w: 200, h: 100 })], ['a'], 'n', [200, 100], [0, 70]), 'a');
    expect(n).toEqual({ x: 100, y: 70, w: 200, h: 130 });
  });

  it('an aspect-locked element dragged by an edge scales about the opposite edge midpoint', () => {
    const p = patchOf(drag([base()], ['a'], 'e', [300, 150], [400, 150]), 'a');
    expect(p.w).toBeCloseTo(300);
    expect(p.h).toBeCloseTo(150);
    expect(p.x).toBeCloseTo(100);
    // Centred on the original mid-line of the west edge.
    expect(p.y + p.h / 2).toBeCloseTo(150);
  });

  it('alt resizes about the centre', () => {
    const p = patchOf(drag([base()], ['a'], 'se', [300, 200], [400, 250], { alt: true }), 'a');
    expect(p.w).toBeCloseTo(400);
    expect(p.h).toBeCloseTo(200);
    expect(p.x + p.w / 2).toBeCloseTo(200);
    expect(p.y + p.h / 2).toBeCloseTo(150);
  });

  it('clamps to the minimum size, keeping the aspect', () => {
    const p = patchOf(drag([base()], ['a'], 'se', [300, 200], [-500, -500]), 'a');
    expect(p.h).toBeCloseTo(MIN_SIZE);
    expect(p.w).toBeCloseTo(MIN_SIZE * 2);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(100);
  });

  it('clamps a free element on each axis separately', () => {
    const p = patchOf(drag([free('a', { x: 100, y: 100, w: 200, h: 100 })], ['a'], 'se', [300, 200], [-500, 400]), 'a');
    expect(p.w).toBe(MIN_SIZE);
    expect(p.h).toBe(300);
  });

  it('clamps the long side to the maximum', () => {
    const p = patchOf(drag([base()], ['a'], 'se', [300, 200], [1e6, 1e6]), 'a');
    expect(Math.max(p.w, p.h)).toBeCloseTo(MAX_SIZE);
    expect(p.w / p.h).toBeCloseTo(2);
  });

  it('does not flip when the pointer crosses the anchor', () => {
    const p = patchOf(drag([free('a', { x: 100, y: 100, w: 200, h: 100 })], ['a'], 'e', [300, 150], [-100, 150]), 'a');
    expect(p.w).toBe(MIN_SIZE);
    expect(p.x).toBe(100);
  });

  it('skips a locked element', () => {
    const s = new ResizeSession(readerOf([base({ locked: true })]), ['a'], 'se', { x: 300, y: 200 });
    expect(s.affected).toEqual([]);
    expect(s.update({ x: 400, y: 300 }, NONE).size).toBe(0);
  });

  it('ignores unknown and repeated ids', () => {
    const s = new ResizeSession(readerOf([base()]), ['ghost', 'a', 'a'], 'se', { x: 300, y: 200 });
    expect(s.affected).toEqual(['a']);
  });
});

describe('ResizeSession: rotated element', () => {
  // 200 x 100 at (100, 100) turned 90 degrees clockwise about (200, 150).
  const start = (rot: number) => el('a', { x: 100, y: 100, w: 200, h: 100, rot, aspectLocked: false });

  it('measures the pointer in the element frame and keeps the opposite corner fixed', () => {
    const e = start(90);
    const r = readerOf([e]);
    // Local (w, h) -> world (150, 250); local (0, 0) -> world (250, 50).
    const anchor = fromRectLocal({ ...e }, 0, 0);
    expect(anchor.x).toBeCloseTo(250);
    expect(anchor.y).toBeCloseTo(50);
    const s = new ResizeSession(r, ['a'], 'se', { x: 150, y: 250 });
    // World south is the element's east: dragging 100 down widens it by 100.
    const p = s.update({ x: 150, y: 350 }, NONE).get('a') as GeometryPatch;
    expect(p.w).toBeCloseTo(300);
    expect(p.h).toBeCloseTo(100);
    const after = fromRectLocal({ ...p, rot: 90 }, 0, 0);
    expect(after.x).toBeCloseTo(anchor.x);
    expect(after.y).toBeCloseTo(anchor.y);
  });

  it('a pointer move along the other world axis changes the other side', () => {
    const s = new ResizeSession(readerOf([start(90)]), ['a'], 'se', { x: 150, y: 250 });
    // World west is the element's south: dragging 40 left makes it 40 taller.
    const p = s.update({ x: 110, y: 250 }, NONE).get('a') as GeometryPatch;
    expect(p.w).toBeCloseTo(200);
    expect(p.h).toBeCloseTo(140);
  });

  it('keeps the anchor of an arbitrary rotation', () => {
    const e = start(33);
    const anchor = fromRectLocal({ ...e }, 0, 0);
    const corner = fromRectLocal({ ...e }, e.w, e.h);
    const s = new ResizeSession(readerOf([e]), ['a'], 'se', corner);
    const p = s.update({ x: corner.x + 30, y: corner.y - 20 }, NONE).get('a') as GeometryPatch;
    const after = fromRectLocal({ ...p, rot: 33 }, 0, 0);
    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
  });
});

describe('ResizeSession: several elements', () => {
  // Shared box (0, 0) .. (300, 100).
  const pair = () => [el('a', { x: 0, y: 0 }), el('b', { x: 200, y: 0 })];

  it('scales every element uniformly about the opposite corner of the shared box', () => {
    const m = drag(pair(), ['a', 'b'], 'se', [300, 100], [600, 200]);
    expect(patchOf(m, 'a')).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    expect(patchOf(m, 'b')).toEqual({ x: 400, y: 0, w: 200, h: 200 });
  });

  it('stays uniform when the pointer moves on one axis only', () => {
    const m = drag(pair(), ['a', 'b'], 'se', [300, 100], [450, 100]);
    expect(patchOf(m, 'a')).toEqual({ x: 0, y: 0, w: 150, h: 150 });
    expect(patchOf(m, 'b')).toEqual({ x: 300, y: 0, w: 150, h: 150 });
  });

  it('anchors the south-east corner when dragging the north-west handle', () => {
    const m = drag(pair(), ['a', 'b'], 'nw', [0, 0], [-300, -100]);
    const a = patchOf(m, 'a');
    const b = patchOf(m, 'b');
    expect(a.w / 100).toBeCloseTo(2);
    expect(b.x + b.w).toBeCloseTo(300);
    expect(b.y + b.h).toBeCloseTo(100);
  });

  it('alt scales about the centre of the shared box', () => {
    const m = drag(pair(), ['a', 'b'], 'se', [300, 100], [450, 150], { alt: true });
    const a = patchOf(m, 'a');
    const b = patchOf(m, 'b');
    expect(a.w).toBeCloseTo(200);
    expect((a.x + b.x + b.w) / 2).toBeCloseTo(150);
    expect((a.y + a.h / 2 + b.y + b.h / 2) / 2).toBeCloseTo(50);
  });

  it('clamps at the minimum size of the shared box', () => {
    const m = drag(pair(), ['a', 'b'], 'se', [300, 100], [-1000, -1000]);
    const a = patchOf(m, 'a');
    // The box shrinks to its minimum edge (the short side, 100 -> MIN_SIZE): scale 0.24.
    expect(a.h).toBeCloseTo(100 * (MIN_SIZE / 100));
  });

  it('leaves locked elements out of the resize', () => {
    const list = [el('a', { x: 0, y: 0 }), el('b', { x: 200, y: 0 }), el('c', { x: 0, y: 300, locked: true })];
    const s = new ResizeSession(readerOf(list), ['a', 'b', 'c'], 'se', { x: 300, y: 100 });
    expect(s.affected).toEqual(['a', 'b']);
    expect(s.update({ x: 600, y: 200 }, NONE).has('c')).toBe(false);
  });
});

describe('ResizeSession: snapping', () => {
  const base = () => free('a', { x: 100, y: 100, w: 200, h: 100 });

  it('applies the snapper correction to the dragged edge', () => {
    const snap = vi.fn(() => ({ dx: -10, dy: 5 }));
    const s = new ResizeSession(readerOf([base()]), ['a'], 'se', { x: 300, y: 200 });
    const p = s.update({ x: 400, y: 250 }, NONE, snap).get('a') as GeometryPatch;
    expect(p).toEqual({ x: 100, y: 100, w: 290, h: 155 });
  });

  it('hands the snapper the proposed box and the dragged edges', () => {
    let seen: { box: unknown; edges: unknown } | null = null;
    const s = new ResizeSession(readerOf([base()]), ['a'], 'se', { x: 300, y: 200 });
    s.update({ x: 400, y: 250 }, NONE, (box, edges) => {
      seen = { box: { ...box }, edges: { ...edges } };
      return { dx: 0, dy: 0 };
    });
    expect(seen).toEqual({
      box: { minX: 100, minY: 100, maxX: 400, maxY: 250 },
      edges: { left: false, right: true, top: false, bottom: true },
    });
  });

  it('flags both opposite edges when resizing about the centre', () => {
    let edges: unknown = null;
    const s = new ResizeSession(readerOf([base()]), ['a'], 'e', { x: 300, y: 150 });
    s.update({ x: 350, y: 150 }, { ...NONE, alt: true }, (_b, e) => {
      edges = { ...e };
      return { dx: 0, dy: 0 };
    });
    expect(edges).toEqual({ left: true, right: true, top: false, bottom: false });
  });

  it('ctrl disables snapping', () => {
    const snap = vi.fn(() => ({ dx: -10, dy: 0 }));
    const s = new ResizeSession(readerOf([base()]), ['a'], 'se', { x: 300, y: 200 });
    const p = s.update({ x: 400, y: 250 }, { ...NONE, ctrl: true }, snap).get('a') as GeometryPatch;
    expect(snap).not.toHaveBeenCalled();
    expect(p.w).toBe(300);
  });

  it('does not snap an element turned by a non-quarter angle, but does at 90 degrees', () => {
    const snap = vi.fn(() => ({ dx: 0, dy: 0 }));
    const s45 = new ResizeSession(readerOf([free('a', { rot: 45 })]), ['a'], 'se', { x: 0, y: 0 });
    s45.update({ x: 10, y: 10 }, NONE, snap);
    expect(snap).not.toHaveBeenCalled();
    const s90 = new ResizeSession(readerOf([free('a', { rot: 90 })]), ['a'], 'se', { x: 0, y: 0 });
    s90.update({ x: 10, y: 10 }, NONE, snap);
    expect(snap).toHaveBeenCalledTimes(1);
  });

  it('maps a rotated element\'s edges to world axes', () => {
    let edges: unknown = null;
    // At 90 degrees the element's east side faces world south.
    const s = new ResizeSession(readerOf([free('a', { rot: 90 })]), ['a'], 'e', { x: 0, y: 0 });
    s.update({ x: 0, y: 10 }, NONE, (_b, e) => {
      edges = { ...e };
      return { dx: 0, dy: 0 };
    });
    expect(edges).toEqual({ left: false, right: false, top: false, bottom: true });
  });

  it('snaps a multi-selection against its shared box', () => {
    let box: unknown = null;
    const list = [el('a', { x: 0, y: 0 }), el('b', { x: 200, y: 0 })];
    const s = new ResizeSession(readerOf(list), ['a', 'b'], 'se', { x: 300, y: 100 });
    const p = s.update({ x: 600, y: 100 }, NONE, (b) => {
      box = { ...b };
      return { dx: -30, dy: 0 };
    });
    expect(box).toEqual({ minX: 0, minY: 0, maxX: 600, maxY: 200 });
    // Corrected pointer x = 570 -> scale 1.9.
    expect(patchOf(p, 'a').w).toBeCloseTo(190);
  });
});

describe('ResizeSession: snapping a resize about the centre', () => {
  const alt = { ...NONE, alt: true };
  // Snaps against the cards of a real store, wired the way the controller does.
  const snapper = (cards: ReturnType<typeof el>[], moved: string[]) => {
    const store = new Store();
    store.add(cards);
    const snap = new SnapSession({ guides: true, grid: false }, 24);
    snap.begin(store, { x0: -1000, y0: -1000, x1: 1000, y1: 1000 }, 1, new Set(moved));
    return (box: Parameters<SnapSession['resize']>[0], edges: Parameters<SnapSession['resize']>[1]) =>
      snap.resize(box, edges);
  };
  // A card whose right edge is the line x = -3, and one whose left edge is x = 103.
  const west = () => el('w', { x: -103, y: 500, w: 100, h: 100 });
  const east = () => el('e', { x: 103, y: 500, w: 100, h: 100 });

  it('lands the opposite edge on its guide: the east handle with Alt snaps the west edge', () => {
    const a = free('a', { x: 0, y: 0, w: 100, h: 100 });
    const s = new ResizeSession(readerOf([a]), ['a'], 'e', { x: 100, y: 50 });
    const p = s.update({ x: 100, y: 50 }, alt, snapper([a, west()], ['a'])).get('a') as GeometryPatch;
    expect(p.x).toBeCloseTo(-3);
    expect(p.w).toBeCloseTo(106);
    expect(p.h).toBe(100);
  });

  it('still lands the dragged edge on its guide', () => {
    const a = free('a', { x: 0, y: 0, w: 100, h: 100 });
    const s = new ResizeSession(readerOf([a]), ['a'], 'e', { x: 100, y: 50 });
    const p = s.update({ x: 100, y: 50 }, alt, snapper([a, east()], ['a'])).get('a') as GeometryPatch;
    expect(p.x + p.w).toBeCloseTo(103);
    expect(p.w).toBeCloseTo(106);
  });

  it('the west handle with Alt snaps the east edge', () => {
    const a = free('a', { x: 0, y: 0, w: 100, h: 100 });
    const s = new ResizeSession(readerOf([a]), ['a'], 'w', { x: 0, y: 50 });
    const p = s.update({ x: 0, y: 50 }, alt, snapper([a, east()], ['a'])).get('a') as GeometryPatch;
    expect(p.x + p.w).toBeCloseTo(103);
    expect(p.x).toBeCloseTo(-3);
  });

  it('an aspect-locked card does the same', () => {
    const a = el('a', { x: 0, y: 0, w: 100, h: 100 });
    const s = new ResizeSession(readerOf([a]), ['a'], 'e', { x: 100, y: 50 });
    const p = s.update({ x: 100, y: 50 }, alt, snapper([a, west()], ['a'])).get('a') as GeometryPatch;
    expect(p.x).toBeCloseTo(-3);
    expect(p.w).toBeCloseTo(106);
    expect(p.h).toBeCloseTo(106);
  });

  it('turned by a quarter, the world edge that snaps is the one that moves', () => {
    // At 90 degrees the element's east side faces world south: a guide at y = 103 is the south edge, and
    // the north edge mirrors it.
    const a = free('a', { x: 0, y: 0, w: 100, h: 100, rot: 90 });
    const south = el('s', { x: 500, y: -103, w: 100, h: 100 });
    const s = new ResizeSession(readerOf([a]), ['a'], 'e', { x: 50, y: 100 });
    const p = s.update({ x: 50, y: 100 }, alt, snapper([a, south], ['a'])).get('a') as GeometryPatch;
    // The element's width runs along world y: its north edge sits on y = -3.
    expect(p.w).toBeCloseTo(106);
    expect(p.y + p.h / 2 - p.w / 2).toBeCloseTo(-3);
  });

  it('a multi-selection scales about its centre onto the guide of the opposite edge', () => {
    const list = [el('a', { x: 0, y: 0 }), el('b', { x: 200, y: 0 })];
    const s = new ResizeSession(readerOf(list), ['a', 'b'], 'se', { x: 300, y: 100 });
    const m = s.update({ x: 300, y: 100 }, alt, snapper([...list, west()], ['a', 'b']));
    // The shared box was 0..300: its west edge is on x = -3 now, so it scaled by 306 / 300.
    expect(patchOf(m, 'a').x).toBeCloseTo(-3);
    expect(patchOf(m, 'a').w).toBeCloseTo(102);
    expect(patchOf(m, 'b').x + patchOf(m, 'b').w).toBeCloseTo(303);
  });

  it('applies the correction as given when the snapper does not name an edge', () => {
    const a = free('a', { x: 100, y: 100, w: 200, h: 100 });
    const s = new ResizeSession(readerOf([a]), ['a'], 'e', { x: 300, y: 150 });
    const p = s.update({ x: 350, y: 150 }, alt, () => ({ dx: -10, dy: 0 })).get('a') as GeometryPatch;
    expect(p.w).toBe(280);
  });

  it('flips the correction of an opposite edge', () => {
    const a = free('a', { x: 100, y: 100, w: 200, h: 100 });
    const s = new ResizeSession(readerOf([a]), ['a'], 'e', { x: 300, y: 150 });
    // The west edge (100 - 50 = 50) wants to move 10 east: the pointer, which pulls it west, moves 10 back.
    const p = s.update({ x: 350, y: 150 }, alt, () => ({ dx: 10, dy: 0, edgeX: 'min' })).get('a') as GeometryPatch;
    expect(p.x).toBeCloseTo(60);
    expect(p.w).toBeCloseTo(280);
  });
});
