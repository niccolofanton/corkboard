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
const full = (cards: PolicyCard[], o: Partial<Parameters<typeof planLive>[0]> = {}) =>
  planLive({ cards, cameraMoving: false, scale: 1, max: 4, ...o });
// The plan without `culled`, which only the culling tests look at.
const plan = (cards: PolicyCard[], o: Partial<Parameters<typeof planLive>[0]> = {}) => {
  const { culled: _culled, ...rest } = full(cards, o);
  return rest;
};

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
  it('wants nothing that is only in the cull margin', () => {
    expect(isEligible(card('a', { screenW: -30, selected: true }), 1, opts)).toBe(false);
    expect(isEligible(card('a', { screenH: -1 }), 1, { minW: 0, minH: 0 })).toBe(false);
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
    expect(plan([card('a'), card('b', { screenW: 100 })])).toEqual({ mount: ['a'], destroy: [], parked: [] });
  });

  it('changes nothing while the camera moves', () => {
    const cards = [card('a'), card('b', { live: true, onScreen: false })];
    expect(plan(cards, { cameraMoving: true })).toEqual({ mount: [], destroy: [], parked: [] });
  });

  it('parks a live card that left the screen instead of destroying it', () => {
    expect(plan([card('a', { live: true, onScreen: false })])).toEqual({ mount: [], destroy: [], parked: ['a'] });
  });

  it('parks a live card that shrank below the keep size', () => {
    const tiny = card('a', { live: true, screenW: MIN_LIVE_W * (KEEP_FACTOR - 0.05), screenH: 20 });
    expect(plan([tiny])).toEqual({ mount: [], destroy: [], parked: ['a'] });
  });

  it('parks a live card below the minimum zoom, selected or not', () => {
    const p = plan([card('a', { live: true, selected: true })], { scale: MIN_LIVE_SCALE - 0.1 });
    expect(p).toEqual({ mount: [], destroy: [], parked: ['a'] });
  });

  it('never newly mounts a parked-class card: only eligible ones mount', () => {
    const p = plan([card('a', { screenW: 20, screenH: 20 }), card('b', { onScreen: false })]);
    expect(p).toEqual({ mount: [], destroy: [], parked: [] });
  });

  it('moves a parked card that regrew to active without mounting it again', () => {
    const p = plan([card('a', { live: true, screenW: 480, screenH: 300 })]);
    expect(p).toEqual({ mount: [], destroy: [], parked: [] });
    expect(p.mount).not.toContain('a');
  });

  it('destroys a live card that cannot be framed', () => {
    expect(plan([card('a', { live: true, frameable: false })])).toEqual({ mount: [], destroy: ['a'], parked: [] });
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
    expect(plan(cards, { max: 2 })).toEqual({ mount: [], destroy: [], parked: [] });
  });

  it('parks the least recently used live card for a selected newcomer', () => {
    const cards = [
      card('a', { live: true, lastUsed: 5 }),
      card('b', { live: true, lastUsed: 1 }),
      card('c', { live: true, lastUsed: 9 }),
      card('n', { selected: true, lastUsed: 10 }),
    ];
    expect(plan(cards, { max: 3 })).toEqual({ mount: ['n'], destroy: [], parked: ['b'] });
  });

  it('puts an interacting card ahead of a selected one', () => {
    const cards = [
      card('sel', { selected: true, lastUsed: 9 }),
      card('int', { interacting: true, live: true, selected: true }),
    ];
    expect(plan(cards, { max: 1 })).toEqual({ mount: [], destroy: [], parked: [] });
    const p = plan([card('sel', { selected: true, live: true, lastUsed: 9 }), cards[1]], { max: 1 });
    expect(p).toEqual({ mount: [], destroy: [], parked: ['sel'] });
  });

  it('prefers the bigger card among equals', () => {
    const p = plan([card('small', { screenW: 400, screenH: 250 }), card('big', { screenW: 900, screenH: 600 })], {
      max: 1,
    });
    expect(p.mount).toEqual(['big']);
  });

  it('shrinks to a lower cap by parking the least recent', () => {
    const cards = [card('a', { live: true, lastUsed: 2 }), card('b', { live: true, lastUsed: 1 })];
    expect(plan(cards, { max: 1 })).toEqual({ mount: [], destroy: [], parked: ['b'] });
  });

  it('is deterministic', () => {
    const cards = ['x', 'y', 'z'].map((id) => card(id));
    expect([...plan(cards, { max: 2 }).mount].sort()).toEqual([...plan([...cards].reverse(), { max: 2 }).mount].sort());
  });
});

describe('planLive: parking budget', () => {
  const parkedCard = (id: string, o: Partial<PolicyCard> = {}) =>
    card(id, { live: true, screenW: 50, screenH: 30, ...o });

  it('defaults the mounted cap to three times the active cap', () => {
    const cards = Array.from({ length: 6 }, (_, i) => parkedCard(`p${i}`, { lastUsed: i }));
    const p = plan(cards, { max: 1 });
    expect(p.parked).toHaveLength(3);
    expect(p.destroy).toHaveLength(3);
  });

  it('destroys the overflow, off-screen cards first, then least recently used', () => {
    const cards = [
      parkedCard('offNew', { onScreen: false, lastUsed: 100 }),
      parkedCard('onOld', { lastUsed: 1 }),
      parkedCard('onMid', { lastUsed: 5 }),
      parkedCard('onNew', { lastUsed: 9 }),
    ];
    const p = plan(cards, { max: 2, maxMounted: 3 });
    expect(p.parked.sort()).toEqual(['onMid', 'onNew', 'onOld']);
    expect(p.destroy).toEqual(['offNew']);
    const q = plan(cards, { max: 2, maxMounted: 2 });
    expect(q.parked.sort()).toEqual(['onMid', 'onNew']);
    expect(q.destroy.sort()).toEqual(['offNew', 'onOld']);
  });

  it('counts the active cards against the mounted cap', () => {
    const cards = [card('act'), parkedCard('p1', { lastUsed: 2 }), parkedCard('p2', { lastUsed: 1 })];
    const p = plan(cards, { max: 4, maxMounted: 2 });
    expect(p).toEqual({ mount: ['act'], destroy: ['p2'], parked: ['p1'] });
  });

  it('breaks ties by screen area, then id', () => {
    const cards = [
      parkedCard('b', { screenW: 80 }),
      parkedCard('a', { screenW: 80 }),
      parkedCard('big', { screenW: 200 }),
    ];
    const p = plan(cards, { max: 0, maxMounted: 2 });
    expect(p.parked.sort()).toEqual(['a', 'big']);
    expect(p.destroy).toEqual(['b']);
  });

  it('still destroys everything when the mounted cap is zero', () => {
    const p = plan([parkedCard('a')], { max: 0, maxMounted: 0 });
    expect(p).toEqual({ mount: [], destroy: ['a'], parked: [] });
  });
});

describe('planLive without a cap', () => {
  it('mounts every eligible card when max is Infinity', () => {
    const cards = Array.from({ length: 50 }, (_, i) => card(`c${i}`));
    const p = plan(cards, { max: Infinity, maxMounted: Infinity });
    expect(p.mount).toHaveLength(50);
    expect(p.destroy).toEqual([]);
  });

  it('defaults the mounted cap to unlimited too, and parks everything mounted', () => {
    const cards = [
      ...Array.from({ length: 20 }, (_, i) => card(`on${i}`, { live: true })),
      ...Array.from({ length: 20 }, (_, i) => card(`off${i}`, { live: true, onScreen: false })),
    ];
    const p = plan(cards, { max: Infinity });
    expect(p.destroy).toEqual([]);
    expect(p.mount).toEqual([]);
    expect(p.parked).toHaveLength(20);
  });

  it('keeps a finite maxMounted under an infinite max', () => {
    const cards = [
      ...Array.from({ length: 5 }, (_, i) => card(`on${i}`, { live: true })),
      ...Array.from({ length: 5 }, (_, i) => card(`off${i}`, { live: true, onScreen: false })),
    ];
    const p = plan(cards, { max: Infinity, maxMounted: 7 });
    expect(p.parked).toHaveLength(2);
    expect(p.destroy).toHaveLength(3);
  });
});


describe('planLive: culled (off screen) frames', () => {
  const offCard = (id: string, o: Partial<PolicyCard> = {}) =>
    card(id, { live: true, onScreen: false, screenW: -50, screenH: -50, ...o });

  it('lists the off-screen mounted cards that are kept, as a subset of parked', () => {
    const p = full([card('act'), card('on', { live: true, screenW: 50, screenH: 30 }), offCard('off')]);
    expect(p.parked.sort()).toEqual(['off', 'on']);
    expect(p.culled).toEqual(['off']);
  });

  it('keeps off-screen frames only up to maxOffscreen, the most recently seen first', () => {
    const cards = [
      offCard('seenOld', { lastSeen: 1, lastUsed: 90 }),
      offCard('seenNew', { lastSeen: 9, lastUsed: 1 }),
      offCard('seenMid', { lastSeen: 5, lastUsed: 50 }),
    ];
    const p = full(cards, { max: 4, maxMounted: 10, maxOffscreen: 2 });
    expect(p.culled.sort()).toEqual(['seenMid', 'seenNew']);
    expect(p.parked.sort()).toEqual(['seenMid', 'seenNew']);
    expect(p.destroy).toEqual(['seenOld']);
  });

  it('falls back to lastUsed when a card was never seen', () => {
    const cards = [offCard('old', { lastUsed: 1 }), offCard('new', { lastUsed: 8 })];
    const p = full(cards, { max: 4, maxMounted: 10, maxOffscreen: 1 });
    expect(p.culled).toEqual(['new']);
    expect(p.destroy).toEqual(['old']);
  });

  it('never limits the on-screen parked ones, and they win the shared maxMounted', () => {
    const on = (id: string, lastUsed: number) => card(id, { live: true, screenW: 50, screenH: 30, lastUsed });
    const cards = [on('a', 1), on('b', 2), on('c', 3), offCard('off', { lastSeen: 99 })];
    const p = full(cards, { max: 0, maxOffscreen: 0, maxMounted: 10 });
    expect(p.parked.sort()).toEqual(['a', 'b', 'c']);
    expect(p.culled).toEqual([]);
    expect(p.destroy).toEqual(['off']);
    // Still within the overall cap: one place left, the on-screen ones take it.
    const q = full(cards, { max: 0, maxOffscreen: 5, maxMounted: 3 });
    expect(q.parked.sort()).toEqual(['a', 'b', 'c']);
    expect(q.destroy).toEqual(['off']);
  });

  it('keeps the old result when maxOffscreen is not given (it defaults to maxMounted)', () => {
    const cards = [offCard('a', { lastUsed: 3 }), offCard('b', { lastUsed: 2 }), offCard('c', { lastUsed: 1 })];
    const p = full(cards, { max: 1, maxMounted: 2 });
    expect(p.parked.sort()).toEqual(['a', 'b']);
    expect(p.destroy).toEqual(['c']);
  });

  it('accepts Infinity', () => {
    const cards = Array.from({ length: 30 }, (_, i) => offCard(`o${i}`, { lastSeen: i }));
    const p = full(cards, { max: Infinity, maxMounted: Infinity, maxOffscreen: Infinity });
    expect(p.culled).toHaveLength(30);
    expect(p.destroy).toEqual([]);
  });

  it('changes nothing while the camera moves', () => {
    expect(full([offCard('a')], { cameraMoving: true }).culled).toEqual([]);
  });
});
