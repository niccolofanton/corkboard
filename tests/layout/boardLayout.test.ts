// BoardLayout against a real Store and a stub stage that keeps the previews and pins it is asked for and
// lets a test run the animation frame by frame: what the store holds while a layout animates, how an
// arrange ends or is replaced, equal width, and where new cards are put.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boxCx, elementBox, type Aabb } from '../../src/interact/geometry';
import { arrangeGap } from '../../src/layout';
import { BoardLayout } from '../../src/BoardLayout';
import { createElement } from '../../src/model';
import type { Stage } from '../../src/render/stage';
import { Store } from '../../src/store';
import type { Card, CardInit } from '../../src/types';

type Rect = { x: number; y: number; w: number; h: number };

// A clock the animation reads.
let now = 0;
beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

function fakeStage(cam: Partial<{ w: number; h: number; empty: boolean }> & { rect?: () => object } = {}) {
  const w = cam.w ?? 1000;
  const h = cam.h ?? 600;
  const previews = new Map<string, Rect & { rot: number }>();
  const pins = new Set<string>();
  let hooks: (() => void)[] = [];
  const stage = {
    cam: {
      scale: 1,
      width: w,
      height: h,
      isEmpty: cam.empty ?? false,
      visibleRect: cam.rect ?? (() => ({ x0: 0, y0: 0, x1: w, y1: h })),
    },
    setPreview: (id: string, x: number, y: number, pw: number, ph: number, rot: number) =>
      void previews.set(id, { x, y, w: pw, h: ph, rot }),
    clearPreview: (id: string) => void previews.delete(id),
    previewRectOf: (id: string) => previews.get(id),
    pin: (id: string, on: boolean) => void (on ? pins.add(id) : pins.delete(id)),
    onBeforeFrame: (hook: () => void) => {
      hooks.push(hook);
      return () => void (hooks = hooks.filter((x) => x !== hook));
    },
    requestFrame: () => {},
  };
  return {
    stage: stage as unknown as Stage,
    previews,
    pins,
    // The time moves on and the stage runs a frame.
    frame: (ms: number) => {
      now += ms;
      for (const hook of [...hooks]) hook();
    },
    hooks: () => hooks.length,
  };
}

let n = 0;
const card = (init: Partial<CardInit> = {}): Card =>
  createElement({ x: 0, y: 0, w: 100, h: 100, media: { src: 'x.jpg' }, ...init }, `c${n++}`);

function board(cards: Card[], stageOpts: Parameters<typeof fakeStage>[0] = {}) {
  const store = new Store();
  store.add(cards);
  const s = fakeStage(stageOpts);
  const layout = new BoardLayout(store, s.stage);
  const changes: { updated: number; ids: string[] }[] = [];
  store.subscribe((e) => {
    changes.push({ updated: e.change.updated.length, ids: e.change.updated.map((u) => u.el.id) });
  });
  const rects = (): Record<string, Rect> =>
    Object.fromEntries(
      [...store.elements()].map((e) => [e.id, { x: e.x, y: e.y, w: e.w, h: e.h }] as const),
    );
  return { store, layout, changes, rects, ...s };
}

// Three cards scattered around the viewport.
const scattered = () => [
  card({ x: 40, y: 30, w: 120, h: 150 }),
  card({ x: 500, y: 100, w: 120, h: 150 }),
  card({ x: 300, y: 400, w: 120, h: 150 }),
];

describe('layout animation', () => {
  it('writes the final rects to the store at once, in one change', () => {
    const b = board(scattered());
    const before = b.rects();
    b.layout.tidy();
    const after = b.rects();
    expect(after).not.toEqual(before);
    expect(b.changes).toHaveLength(1);
    // Every card that changed is in it (the one the grid is anchored on may stay).
    const moved = Object.keys(after).filter((id) => JSON.stringify(after[id]) !== JSON.stringify(before[id]));
    expect(b.changes[0].ids.sort()).toEqual(moved.sort());
    expect(moved.length).toBeGreaterThanOrEqual(2);
    // Nothing more is written while it animates, nor when it ends.
    b.frame(100);
    b.frame(300);
    expect(b.rects()).toEqual(after);
    expect(b.changes).toHaveLength(1);
  });

  it('what is asked right after is the new arrangement: get, hit area, bounds', () => {
    const b = board(scattered());
    const ids = [...b.store.ids()];
    const twin = board(ids.map((id) => ({ ...(b.store.get(id) as Card) })));
    twin.layout.tidy(undefined, { animate: false });
    b.layout.tidy();
    expect(b.rects()).toEqual(twin.rects());
    // The spatial index too: a card is found where it is now, not where it was.
    for (const id of ids) {
      const el = b.store.get(id) as Card;
      expect(b.store.searchInto(elementBox(el), []).map((e) => e.id)).toContain(id);
    }
    const old = elementBox(scattered()[2]);
    expect(b.store.searchInto({ ...old, minX: old.minX + 1, maxX: old.maxX - 1 }, []).map((e) => e.id)).not.toContain(
      ids[2],
    );
  });

  it('draws the cards from where they were to where they are, then lets go', () => {
    const cards = scattered();
    const from = cards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
    const b = board(cards);
    b.layout.tidy(undefined, { duration: 200 });
    const to = b.rects();
    const ids = [...b.store.ids()];
    // First frame: the old arrangement, the cards held by the stage.
    ids.forEach((id, i) => expect(b.previews.get(id)).toMatchObject(from[i]));
    expect(b.pins.size).toBe(3);
    // Half way (the easing is not linear: just somewhere between).
    b.frame(100);
    const mid = b.previews.get(ids[2]) as Rect;
    expect(mid.y).toBeGreaterThan(Math.min(from[2].y, to[ids[2]].y));
    expect(mid.y).toBeLessThan(Math.max(from[2].y, to[ids[2]].y));
    // The end.
    b.frame(200);
    expect(b.previews.size).toBe(0);
    expect(b.pins.size).toBe(0);
    expect(b.hooks()).toBe(0);
  });

  it('animate: false writes once and previews nothing', () => {
    const b = board(scattered());
    b.layout.tidy(undefined, { animate: false });
    expect(b.changes).toHaveLength(1);
    expect(b.previews.size).toBe(0);
    expect(b.pins.size).toBe(0);
    expect(b.hooks()).toBe(0);
  });

  it('a new arrange mid-animation continues from where the cards are drawn and ends clean', () => {
    const b = board(scattered());
    b.layout.tidy(undefined, { duration: 200 });
    b.frame(80);
    const ids = [...b.store.ids()];
    const drawn = ids.map((id) => ({ ...(b.previews.get(id) as Rect) }));
    b.layout.masonry(undefined, { duration: 200, columns: 1 });
    // No jump: the new animation starts at what was on screen.
    ids.forEach((id, i) => expect(b.previews.get(id)).toMatchObject(drawn[i]));
    expect(b.hooks()).toBe(1);
    const final = b.rects();
    b.frame(250);
    expect(b.previews.size).toBe(0);
    expect(b.pins.size).toBe(0);
    expect(b.hooks()).toBe(0);
    expect(b.rects()).toEqual(final);
    // One change per arrange.
    expect(b.changes).toHaveLength(2);
  });

  it('a card dropped from the second arrange stops where the first one was taking it', () => {
    const b = board(scattered());
    const ids = [...b.store.ids()];
    b.layout.tidy(undefined, { duration: 200 });
    const firstFinal = b.rects();
    b.frame(50);
    b.layout.align('left', [ids[0], ids[1]], { duration: 200 });
    // The third card is no longer animated: it shows the store's rect.
    expect(b.previews.has(ids[2])).toBe(false);
    expect(b.pins.has(ids[2])).toBe(false);
    expect(b.rects()[ids[2]]).toEqual(firstFinal[ids[2]]);
    b.frame(300);
    expect(b.previews.size).toBe(0);
    expect(b.pins.size).toBe(0);
  });

  it('a card removed mid-animation leaves no preview behind', () => {
    const b = board(scattered());
    const ids = [...b.store.ids()];
    b.layout.tidy(undefined, { duration: 200 });
    b.store.remove([ids[1]]);
    // What the stage does for a removed card.
    b.previews.delete(ids[1]);
    b.pins.delete(ids[1]);
    b.frame(50);
    expect(b.previews.has(ids[1])).toBe(false);
    b.frame(300);
    expect(b.previews.size).toBe(0);
    expect(b.pins.size).toBe(0);
  });

  it('cards far from the view jump without a preview', () => {
    const far = [card({ x: 50_000, y: 0 }), card({ x: 50_300, y: 0 })];
    const b = board(far);
    b.layout.align('top', undefined, { duration: 200 });
    b.layout.distribute('x', undefined, { duration: 200 });
    b.layout.tidy(undefined, { duration: 200 });
    expect(b.previews.size).toBe(0);
    expect(b.hooks()).toBe(0);
  });
});

describe('equalWidth', () => {
  // A row of 200, 300 and 400 wide cards: they all become 300 wide and the grown ones used to overlap.
  const row = () => [
    card({ x: 0, y: 0, w: 200, h: 200, rot: 0 }),
    card({ x: 220, y: 0, w: 300, h: 300 }),
    card({ x: 540, y: 0, w: 400, h: 400 }),
  ];
  const boxes = (b: ReturnType<typeof board>): Aabb[] => [...b.store.elements()].map((e) => elementBox(e));
  const overlap = (a: Aabb, c: Aabb, gap: number): boolean =>
    a.minX < c.maxX + gap - 1e-6 &&
    c.minX < a.maxX + gap - 1e-6 &&
    a.minY < c.maxY + gap - 1e-6 &&
    c.minY < a.maxY + gap - 1e-6;

  it('gives every card the median width and separates what overlaps, by the arrange gap', () => {
    const b = board(row());
    b.layout.equalWidth(undefined, { animate: false });
    expect([...b.store.elements()].map((e) => e.w)).toEqual([300, 300, 300]);
    const gap = arrangeGap([200, 300, 400]);
    const list = boxes(b);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) expect(overlap(list[i], list[j], gap)).toBe(false);
    }
  });

  it('keeps the rotation of the cards', () => {
    const cards = [
      card({ x: 0, y: 0, w: 200, h: 200, rot: 30 }),
      card({ x: 500, y: 0, w: 400, h: 400, rot: -15 }),
      card({ x: 1200, y: 0, w: 300, h: 300, rot: 90 }),
    ];
    const b = board(cards);
    b.layout.equalWidth(undefined, { animate: false });
    expect([...b.store.elements()].map((e) => e.rot)).toEqual([30, -15, 90]);
    expect([...b.store.elements()].map((e) => e.w)).toEqual([300, 300, 300]);
  });

  it('writes once, with no change when every card has the width already', () => {
    const b = board(row());
    b.layout.equalWidth(undefined, { animate: false });
    expect(b.changes).toHaveLength(1);
    const same = board([card({ w: 300 }), card({ x: 400, w: 300 }), card({ x: 800, w: 300 })]);
    same.layout.equalWidth(undefined, { animate: false });
    expect(same.changes).toHaveLength(0);
  });

  it('leaves locked cards alone', () => {
    const cards = row();
    cards[2] = { ...cards[2], locked: true };
    const b = board(cards);
    b.layout.equalWidth(undefined, { animate: false });
    expect((b.store.get(cards[2].id) as Card).w).toBe(400);
  });
});

describe('placing new cards', () => {
  const placed = (b: ReturnType<typeof board>, init: Partial<CardInit>): Card => {
    const el = card({ ...init, w: init.w ?? 100, h: init.h ?? 100 });
    b.layout.placeNew([el], new Set([el.id]));
    b.store.add([el]);
    return el;
  };
  // True when no other card shares any area with `el`.
  const clear = (b: ReturnType<typeof board>, el: Card): boolean => {
    const inner = { minX: el.x + 0.5, minY: el.y + 0.5, maxX: el.x + el.w - 0.5, maxY: el.y + el.h - 0.5 };
    return b.store.searchInto(inner, []).every((o) => o.id === el.id);
  };

  it('does not land on a card beyond half a screen from the view, on a dense board', () => {
    // A 100 px lattice of cards over 5000 x 5000 px with one 200 x 200 hole out at x = 2050.
    const cards: Card[] = [];
    for (let x = -2200; x < 3000; x += 100) {
      for (let y = -2200; y < 2800; y += 100) {
        if (x >= 2000 && x < 2200 && y >= 200 && y < 400) continue;
        cards.push(card({ x, y, w: 100, h: 100 }));
      }
    }
    const b = board(cards);
    const el = placed(b, {});
    expect(clear(b, el)).toBe(true);
    expect(el.x).toBeGreaterThanOrEqual(2000);
    expect(el.x + el.w).toBeLessThanOrEqual(2200);
  });

  it('spreads cards added while the host has no size, around the camera centre', () => {
    // The camera reports a 1 px placeholder viewport.
    const b = board([], { w: 1, h: 1, empty: true, rect: () => ({ x0: 0, y0: 0, x1: 1, y1: 1 }) });
    const els = [0, 1, 2, 3, 4].map(() => placed(b, { w: 200, h: 200 }));
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = elementBox(els[i]);
        const c = elementBox(els[j]);
        const apart = a.maxX <= c.minX || c.maxX <= a.minX || a.maxY <= c.minY || c.maxY <= a.minY;
        expect(apart, `${i} / ${j}`).toBe(true);
      }
    }
    // The first one is centred on the camera.
    expect(boxCx(elementBox(els[0]))).toBeCloseTo(0.5);
  });

  it('keeps the x or y a card was added with', () => {
    const b = board([]);
    const el = card({ w: 100, h: 100 });
    b.layout.placeNew([el], new Set([el.id]), new Map([[el.id, { x: 700 }]]));
    expect(el.x).toBe(700);
    expect(el.y).not.toBe(700);
    const el2 = card({ w: 100, h: 100 });
    b.layout.placeNew([el2], new Set([el2.id]), new Map([[el2.id, { y: -300 }]]));
    expect(el2.y).toBe(-300);
    expect(Number.isFinite(el2.x)).toBe(true);
  });

  it('finishes with a camera that is NaN, and puts the card somewhere finite', () => {
    const nan = { x0: NaN, y0: NaN, x1: NaN, y1: NaN };
    const b = board([card()], { rect: () => nan });
    const el = placed(b, {});
    expect(Number.isFinite(el.x) && Number.isFinite(el.y)).toBe(true);
  });
});
