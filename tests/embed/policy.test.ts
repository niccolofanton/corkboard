import { describe, expect, it } from 'vitest';
import {
  isEligible,
  KEEP_FACTOR,
  MIN_LIVE_H,
  MIN_LIVE_SCALE,
  MIN_LIVE_W,
  planLive,
  type PolicyCard,
} from '../../src/embed/policy';

const card = (id: string, o: Partial<PolicyCard> = {}): PolicyCard => ({
  id,
  screenW: 480,
  screenH: 300,
  onScreen: true,
  selected: false,
  interacting: false,
  frameable: true,
  live: false,
  lastUsed: 0,
  ...o,
});
const plan = (cards: PolicyCard[], o: Partial<Parameters<typeof planLive>[0]> = {}) =>
  planLive({ cards, cameraMoving: false, scale: 1, max: 4, ...o });

describe('eligibility', () => {
  const opts = {};
  it('wants a card on screen that is big enough', () => {
    expect(isEligible(card('a'), 1, opts)).toBe(true);
    expect(isEligible(card('a', { screenW: MIN_LIVE_W - 1 }), 1, opts)).toBe(false);
    expect(isEligible(card('a', { screenH: MIN_LIVE_H - 1 }), 1, opts)).toBe(false);
  });
  it('wants a selected card at any size', () => {
    expect(isEligible(card('a', { screenW: 90, screenH: 50, selected: true }), 1, opts)).toBe(true);
  });
  it('never mounts below the minimum zoom, selected or not', () => {
    expect(isEligible(card('a', { selected: true }), MIN_LIVE_SCALE - 0.01, opts)).toBe(false);
    expect(isEligible(card('a'), MIN_LIVE_SCALE, opts)).toBe(true);
  });
  it('wants nothing off screen or that cannot be framed', () => {
    expect(isEligible(card('a', { onScreen: false, selected: true }), 1, opts)).toBe(false);
    expect(isEligible(card('a', { frameable: false, selected: true }), 1, opts)).toBe(false);
  });
  it('keeps a live card a bit below the size that earned it the iframe', () => {
    const small = { screenW: MIN_LIVE_W * 0.8, screenH: MIN_LIVE_H * 0.8 };
    expect(isEligible(card('a', small), 1, opts)).toBe(false);
    expect(isEligible(card('a', { ...small, live: true }), 1, opts)).toBe(true);
    const tiny = { screenW: MIN_LIVE_W * (KEEP_FACTOR - 0.05), screenH: MIN_LIVE_H };
    expect(isEligible(card('a', { ...tiny, live: true }), 1, opts)).toBe(false);
  });
  it('honours a custom threshold', () => {
    const c = card('a', { screenW: 200, screenH: 120 });
    expect(isEligible(c, 1, { minW: 160, minH: 100 })).toBe(true);
  });
});

describe('planLive', () => {
  it('mounts the eligible cards', () => {
    expect(plan([card('a'), card('b', { screenW: 100 })])).toEqual({ mount: ['a'], destroy: [] });
  });

  it('changes nothing while the camera moves', () => {
    const cards = [card('a'), card('b', { live: true, onScreen: false })];
    expect(plan(cards, { cameraMoving: true })).toEqual({ mount: [], destroy: [] });
  });

  it('destroys a live card that left the screen', () => {
    expect(plan([card('a', { live: true, onScreen: false })])).toEqual({ mount: [], destroy: ['a'] });
  });

  it('never exceeds the cap', () => {
    const cards = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => card(id));
    const p = plan(cards, { max: 4 });
    expect(p.mount).toHaveLength(4);
    expect(p.destroy).toHaveLength(0);
  });

  it('with one slot (touch) mounts one', () => {
    expect(plan([card('a'), card('b')], { max: 1 }).mount).toHaveLength(1);
    expect(plan([card('a'), card('b')], { max: 0 }).mount).toHaveLength(0);
  });

  it('keeps the live ones against bigger newcomers', () => {
    const cards = [
      card('old1', { live: true, screenW: 400, screenH: 250 }),
      card('old2', { live: true, screenW: 400, screenH: 250 }),
      card('new', { screenW: 900, screenH: 600 }),
    ];
    expect(plan(cards, { max: 2 })).toEqual({ mount: [], destroy: [] });
  });

  it('evicts the least recently used live card for a selected newcomer', () => {
    const cards = [
      card('a', { live: true, lastUsed: 5 }),
      card('b', { live: true, lastUsed: 1 }),
      card('c', { live: true, lastUsed: 9 }),
      card('n', { selected: true, lastUsed: 10 }),
    ];
    expect(plan(cards, { max: 3 })).toEqual({ mount: ['n'], destroy: ['b'] });
  });

  it('puts an interacting card ahead of a selected one', () => {
    const cards = [
      card('sel', { selected: true, lastUsed: 9 }),
      card('int', { interacting: true, live: true, selected: true }),
    ];
    expect(plan(cards, { max: 1 })).toEqual({ mount: [], destroy: [] });
    const p = plan([card('sel', { selected: true, live: true, lastUsed: 9 }), cards[1]], { max: 1 });
    expect(p).toEqual({ mount: [], destroy: ['sel'] });
  });

  it('prefers the bigger card among equals', () => {
    const p = plan([card('small', { screenW: 400, screenH: 250 }), card('big', { screenW: 900, screenH: 600 })], {
      max: 1,
    });
    expect(p.mount).toEqual(['big']);
  });

  it('shrinks to a lower cap by destroying the least recent', () => {
    const cards = [card('a', { live: true, lastUsed: 2 }), card('b', { live: true, lastUsed: 1 })];
    expect(plan(cards, { max: 1 })).toEqual({ mount: [], destroy: ['b'] });
  });

  it('is deterministic', () => {
    const cards = ['x', 'y', 'z'].map((id) => card(id));
    expect([...plan(cards, { max: 2 }).mount].sort()).toEqual([...plan([...cards].reverse(), { max: 2 }).mount].sort());
  });
});
