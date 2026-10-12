import { describe, expect, it } from 'vitest';
import {
  AMBIENT_MAX_PLAYING,
  AMBIENT_MAX_STREAMS,
  AMBIENT_MIN_PLAY_PX,
  ambientAllowed,
  planAmbient,
  type AmbientCandidate,
  type AmbientEnv,
} from '../../src/video/ambientPolicy';

const CAM = { tx: 0, ty: 0, scale: 1 };
const VIEW = { w: 1000, h: 800 };

const card = (id: string, x: number, y: number, w = 200, h = 200): AmbientCandidate => ({
  id,
  x,
  y,
  w,
  h,
});

const plan = (cards: AmbientCandidate[], over: Partial<Parameters<typeof planAmbient>[0]> = {}) =>
  planAmbient({ cards, camera: CAM, viewport: VIEW, ...over });

const env = (over: Partial<Record<keyof AmbientEnv, boolean>> = {}): AmbientEnv => ({
  reducedMotion: () => over.reducedMotion ?? false,
  saveData: () => over.saveData ?? false,
  hidden: () => over.hidden ?? false,
});

describe('planAmbient: which cards play', () => {
  it('plays the cards in the viewport', () => {
    expect(plan([card('a', 0, 0), card('b', 400, 300)]).sort()).toEqual(['a', 'b']);
  });

  it('plays cards a margin outside the viewport, not farther', () => {
    // The margin is a quarter of the viewport: 250 px on the right of a 1000 px viewport.
    expect(plan([card('near', 1100, 0), card('far', 1300, 0)])).toEqual(['near']);
    expect(plan([card('above', 0, -350), card('far', 0, -700)])).toEqual(['above']);
  });

  it('follows the camera: panning away from a card stops it, panning to it starts it', () => {
    const cards = [card('a', 0, 0), card('z', 5000, 0)];
    expect(plan(cards)).toEqual(['a']);
    expect(plan(cards, { camera: { tx: -4900, ty: 0, scale: 1 } })).toEqual(['z']);
  });

  it('has a minimum on-screen size on the long side: a card too small at this zoom does not play', () => {
    const cards = [card('a', 100, 100, 300, 120)];
    expect(AMBIENT_MIN_PLAY_PX).toBe(160);
    // 300 px wide: plays down to a zoom of 160 / 300.
    expect(plan(cards, { camera: { tx: 0, ty: 0, scale: 0.54 } })).toEqual(['a']);
    expect(plan(cards, { camera: { tx: 0, ty: 0, scale: 0.53 } })).toEqual([]);
    for (const scale of [0.3, 0.1, 0.02]) expect(plan(cards, { camera: { tx: 0, ty: 0, scale } })).toEqual([]);
    // The long side counts, not the width: a tall card.
    expect(plan([card('t', 0, 0, 40, 200)])).toEqual(['t']);
    // The threshold is an option, and 0 lifts it.
    expect(plan(cards, { camera: { tx: 0, ty: 0, scale: 0.1 }, minPlayPx: 20 })).toEqual(['a']);
    expect(plan(cards, { camera: { tx: 0, ty: 0, scale: 0.01 }, minPlayPx: 0 })).toEqual(['a']);
  });

  it('plays nothing on a zoomed-out canvas, like the 60 playing at 10 % that this replaces', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      card(`c${String(i).padStart(3, '0')}`, (i % 20) * 220, Math.floor(i / 20) * 220, 200, 200),
    );
    // 20 x 20 cards of 200 px at 0.1: 20 px on screen.
    const camera = { tx: 0, ty: 0, scale: 0.1 };
    expect(plan(many, { camera })).toEqual([]);
    // Zoomed in enough for the size, the cap is what limits it.
    expect(plan(many, { camera: { tx: 0, ty: 0, scale: 0.9 } })).toHaveLength(AMBIENT_MAX_PLAYING);
    // Both limits lifted, only the absolute ceiling is left.
    expect(plan(many, { camera, minPlayPx: 0, cap: 1000 })).toHaveLength(AMBIENT_MAX_STREAMS);
  });

  it('plays nothing without a viewport or with a ceiling of zero', () => {
    expect(plan([card('a', 0, 0)], { viewport: { w: 0, h: 0 } })).toEqual([]);
    expect(plan([card('a', 0, 0)], { cap: 0 })).toEqual([]);
  });

  it('takes the rotated box of a card: a card turned into view plays', () => {
    // 600 x 100 centred at (500, -250): flat, it ends at y = -200, the edge of the margin; turned 90 deg
    // about its centre it spans y -550..50 and reaches into the viewport.
    const flat: AmbientCandidate = { id: 'r', x: 200, y: -300, w: 600, h: 100 };
    expect(plan([flat])).toEqual([]);
    expect(plan([{ ...flat, rot: 90 }])).toEqual(['r']);
  });
});

describe('planAmbient: the safety ceiling', () => {
  const grid = (n: number): AmbientCandidate[] =>
    Array.from({ length: n }, (_, i) =>
      card(`c${String(i).padStart(2, '0')}`, (i % 5) * 200, Math.floor(i / 5) * 200),
    );

  it('plays at most 8 by default, and every card when there are fewer', () => {
    expect(AMBIENT_MAX_PLAYING).toBe(8);
    expect(plan(grid(20))).toHaveLength(8);
    expect(plan(grid(3))).toHaveLength(3);
    expect(plan(grid(20), { cap: 20 })).toHaveLength(20);
  });

  it('never plays more than the ceiling it is given', () => {
    expect(plan(grid(20), { cap: 12 })).toHaveLength(12);
    expect(plan(grid(20), { cap: 6 })).toHaveLength(6);
    expect(plan(grid(3), { cap: 6 })).toHaveLength(3);
  });

  it('never lets a card in the margin take the place of a card in view', () => {
    const inView = Array.from({ length: 5 }, (_, i) => card(`v${i}`, i * 150, 0, 140, 140));
    const margin = Array.from({ length: 5 }, (_, i) => card(`m${i}`, 1010 + i * 50, 0, 600, 600));
    const ids = plan([...margin, ...inView], { cap: 5, minPlayPx: 0 });
    expect(ids.sort()).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
  });

  it('prefers the cards that show the most', () => {
    const cards = [
      card('small', 0, 0, 120, 120),
      card('big', 300, 0, 500, 500),
      card('half', -100, 300, 200, 200),
    ];
    expect(plan(cards, { cap: 2 })).toEqual(['big', 'half']);
  });

  it('prefers cards in the viewport to cards only in the margin, whatever their size', () => {
    const cards = [card('margin', 1050, 0, 600, 600), card('in', 10, 10, 180, 180)];
    expect(plan(cards, { cap: 1 })).toEqual(['in']);
    expect(plan(cards, { cap: 2 })).toEqual(['in', 'margin']);
  });

  it('keeps a playing card over a near-equal newcomer, but not over a clearly better one', () => {
    const cards = [card('a', 0, 0, 200, 200), card('b', 300, 0, 210, 210)];
    expect(plan(cards, { cap: 1 })).toEqual(['b']);
    expect(plan(cards, { cap: 1, playing: new Set(['a']) })).toEqual(['a']);
    const better = [card('a', 0, 0, 200, 200), card('b', 300, 0, 400, 400)];
    expect(plan(better, { cap: 1, playing: new Set(['a']) })).toEqual(['b']);
  });

  it('breaks a tie between equal cards by the distance to the centre of the view', () => {
    // 200 px cards, all fully in view: the two nearest the centre (500, 400) win.
    const cards = [card('corner', 0, 0), card('mid', 400, 300), card('near', 500, 300), card('edge', 800, 600)];
    expect(plan(cards, { cap: 2 })).toEqual(['mid', 'near']);
  });

  it('does not depend on the order the cards arrive in', () => {
    const cards = grid(20);
    expect(plan([...cards].reverse(), { cap: 7 })).toEqual(plan(cards, { cap: 7 }));
  });
});

describe('the page environment', () => {
  it('does not start anything on its own with reduced motion or data saver', () => {
    expect(ambientAllowed(env())).toBe(true);
    expect(ambientAllowed(env({ reducedMotion: true }))).toBe(false);
    expect(ambientAllowed(env({ saveData: true }))).toBe(false);
  });
});
