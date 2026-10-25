// The real Stage in jsdom, with Pixi's Application stubbed (see stageFakes.ts): store events, mounting,
// card / texture bookkeeping, theme, DPR, the loop's parking and its hooks. Nothing here draws a pixel; what
// is checked is what the stage decides and tells the texture manager and the camera.
// Pixi probes a 2D canvas on import; jsdom has none and would print a not-implemented error.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
vi.mock('pixi.js', async (importOriginal) =>
  (await import('./stageFakes')).withFakeApplication(await importOriginal<typeof import('pixi.js')>()),
);
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cache } from 'pixi.js';
import { createElement } from '../../src/model';
import { Stage } from '../../src/render/stage';
import type { BoardCard } from '../../src/render/types';
import type { MediaView } from '../../src/render/views/mediaView';
import { DARK_THEME, LIGHT_THEME } from '../../src/render/theme';
import { Store } from '../../src/store';
import type { Element, MediaSource } from '../../src/types';
import { fake, FakeWorker, installDom, type Dom } from './stageFakes';

let dom: Dom;
let stages: Stage[] = [];
// Decode requests already answered by `land`.
let answered = new Set<number>();
beforeEach(() => {
  dom = installDom();
  stages = [];
  answered = new Set();
});
afterEach(() => {
  for (const s of stages) s.dispose();
  dom.restore();
  vi.restoreAllMocks();
});

// 'AQIDBAU=' is five bytes: a ThumbHash as far as the stage is concerned (the worker is a stub).
const HASH = 'AQIDBAU=';
function dispose(stage: Stage): void {
  stages = stages.filter((s) => s !== stage);
  stage.dispose();
}

const el = (id: string, x = 0, y = 0, w = 200, h = 100, media?: MediaSource): Element =>
  createElement({ x, y, w, h, media: media ?? { src: `${id}.jpg`, thumbhash: HASH } }, id);

async function boot(els: Element[] = []) {
  const store = new Store();
  store.add(els);
  const stage = await Stage.create(dom.host, { workers: 1 });
  stages.push(stage);
  stage.attach(store);
  return { stage, store };
}

// The parts of the stage the tests look into.
interface Inner {
  bg: { alpha: number; visible: boolean; texture: { destroyed: boolean } };
  slotOf: Map<string, number>;
  slotCard: (BoardCard | null)[];
  slotLevel: Int8Array;
  mountedWin: unknown;
  ctx: { dpr: number };
  overlay: { setDpr: (d: number) => void };
  lost: boolean;
  counters: { renderErrors: number; hookErrors: number };
}
const inner = (s: Stage) => s as unknown as Inner;

// Answers every decode request (up to `maxLevel`) the stage's texture manager has not answered yet with a
// bitmap, as the decode worker would.
function land(maxLevel = 1): void {
  for (const w of FakeWorker.all) {
    for (const m of w.loads) {
      if (answered.has(m.rid) || (m.level ?? 0) > maxLevel) continue;
      answered.add(m.rid);
      const size = m.level === 0 ? 32 : 128;
      w.reply({
        op: 'done',
        rid: m.rid,
        bitmap: { width: size, height: size, close: () => {} },
        w: size,
        h: size,
        fetched: 1,
        decodeMs: 1,
      });
    }
  }
}

const media = (src: string, thumbhash: string | undefined = HASH): MediaSource => ({ src, thumbhash });
// The card (the texture manager's view of an element) a slot holds, by element id.
const cardOf = (s: Stage, id: string): BoardCard =>
  inner(s).slotCard[inner(s).slotOf.get(id) as number] as BoardCard;

describe('Stage store events', () => {
  it('mounts a card, draws, and parks', async () => {
    const { stage } = await boot([el('a')]);
    dom.drain();
    expect(stage.isMounted('a')).toBe(true);
    expect(fake.app!.renders).toBeGreaterThan(0);
    expect(dom.frames).toHaveLength(0);
  });

  describe('an id removed and added again before the tick', () => {
    const check = async (swap: (store: Store, next: Element) => void) => {
      const { stage, store } = await boot([el('a', 0, 0, 200, 100)]);
      dom.drain();
      swap(store, el('a', 300, 400, 100, 100, media('new.jpg')));
      dom.drain();
      const v = stage.viewOf('a');
      expect(v).not.toBeNull();
      // The new element, not the old one: its geometry and its picture.
      expect(v!.el!.x).toBe(300);
      expect([v!.display.position.x, v!.display.position.y]).toEqual([350, 450]);
      expect(v!.display.pivot.x).toBe(50);
      expect(cardOf(stage, 'a').l1Url).toBe('new.jpg');
      expect(cardOf(stage, 'a').w).toBe(100);
    };

    it('mounts the new element (one change set)', () =>
      check((store, next) =>
        store.batch(() => {
          store.remove(['a']);
          store.add([next]);
        }),
      ));

    it('mounts the new element (two change sets)', () =>
      check((store, next) => {
        store.remove(['a']);
        store.add([next]);
      }));
  });

  describe('a media change on a card that has no view', () => {
    // A card far outside the window: no view, but a card and a ThumbHash texture of the old picture.
    const farAway = async () => {
      const { stage, store } = await boot([el('far', 100000, 0)]);
      dom.drain();
      expect(stage.isMounted('far')).toBe(false);
      land();
      dom.drain();
      expect(stage.tm.has(cardOf(stage, 'far'), 0)).toBe(true);
      return { stage, store };
    };

    it('forgets the resident textures when a rendition URL changed', async () => {
      const { stage, store } = await farAway();
      const card = cardOf(stage, 'far');
      store.update('far', { media: media('other.jpg') });
      dom.drain();
      expect(card.l1Url).toBe('other.jpg');
      expect(stage.tm.has(card, 0)).toBe(false);
    });

    it('forgets them when only the ThumbHash changed, and keeps them when nothing did', async () => {
      const { stage, store } = await farAway();
      const card = cardOf(stage, 'far');
      store.update('far', { x: 100010 });
      store.update('far', { media: media('far.jpg') });
      dom.drain();
      expect(stage.tm.has(card, 0)).toBe(true);
      // The same bytes in a new array are the same hash.
      store.update('far', { media: { src: 'far.jpg', thumbhash: new Uint8Array([1, 2, 3, 4, 5]) } });
      dom.drain();
      expect(stage.tm.has(card, 0)).toBe(true);
      store.update('far', { media: media('far.jpg', 'AQIDBAY=') });
      dom.drain();
      expect(stage.tm.has(card, 0)).toBe(false);
    });

    it('also when the store is reloaded with other media under the same id', async () => {
      const { stage, store } = await farAway();
      const card = cardOf(stage, 'far');
      store.clear();
      store.add([el('far', 100000, 0, 200, 100, media('reloaded.jpg'))], 'load');
      dom.drain();
      expect(card.l1Url).toBe('reloaded.jpg');
      expect(stage.tm.has(card, 0)).toBe(false);
    });
  });

  it('forgets the textures of a mounted card whose ThumbHash changed', async () => {
    const { stage, store } = await boot([el('a')]);
    dom.drain();
    land();
    dom.drain();
    const card = cardOf(stage, 'a');
    expect(stage.tm.has(card, 0)).toBe(true);
    store.update('a', { media: media('a.jpg', 'AQIDBAY=') });
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(false);
  });

  it('forgets the textures of a card whose kind (and media) changed under it', async () => {
    const { stage, store } = await boot([el('a')]);
    dom.drain();
    land();
    dom.drain();
    const card = cardOf(stage, 'a');
    expect(stage.tm.has(card, 0)).toBe(true);
    store.update('a', { kind: 'video', media: { ...media('poster.jpg'), video: 'a.mp4' } });
    dom.drain();
    expect(card.l1Url).toBe('poster.jpg');
    expect(stage.tm.has(card, 0)).toBe(false);
  });
});

describe('Stage poster overrides', () => {
  // A booted card whose L0 and L1 of the element's own picture are resident and on screen.
  const resident = async (els: Element[] = [el('a')]) => {
    const { stage, store } = await boot(els);
    dom.drain();
    land();
    dom.drain();
    const view = stage.viewOf(els[0].id) as MediaView;
    expect(view.shown).toBeGreaterThanOrEqual(1);
    return { stage, store, view, card: cardOf(stage, els[0].id) };
  };
  const urlsAsked = (): string[] => FakeWorker.all.flatMap((w) => w.loads.map((m) => m.url as string));

  it('requests the override for every level instead of media.src and sizes, and keeps the ThumbHash', async () => {
    const { stage, card } = await resident();
    const hash = card.thumbhash;
    stage.setPosterOverride('a', 'blob:p1');
    dom.drain();
    expect([card.l1Url, card.l2Url, card.l3Url]).toEqual(['blob:p1', 'blob:p1', 'blob:p1']);
    expect(card.thumbhash).toBe(hash);
    expect(stage.tm.has(card, 0)).toBe(true);
    expect(urlsAsked()).toContain('blob:p1');
  });

  it('is used by a card that is built after it was set, and by a store update that leaves the media alone', async () => {
    const { stage, store } = await boot([el('far', 100000, 0)]);
    stage.setPosterOverride('far', 'blob:early');
    dom.drain();
    expect(cardOf(stage, 'far').l1Url).toBe('blob:early');
    store.update('far', { x: 100010 });
    dom.drain();
    expect(cardOf(stage, 'far').l1Url).toBe('blob:early');
  });

  it('never shows the placeholder while the new picture decodes, then switches when its first level lands', async () => {
    const { stage, view, card } = await resident();
    const set = vi.spyOn(view, 'setTexture');
    const old = view.shown;
    stage.setPosterOverride('a', 'blob:p1');
    dom.drain();
    // The old picture is still what is on screen, and the stage knows it is not the poster yet.
    expect(view.shown).toBe(old);
    expect(stage.tm.hasOutgoing(card)).toBe(true);
    expect(stage.posterShown('a')).toBe(false);
    land();
    dom.drain();
    expect(stage.tm.hasOutgoing(card)).toBe(false);
    expect(view.shown).toBeGreaterThanOrEqual(1);
    expect(stage.posterShown('a')).toBe(true);
    expect(set.mock.calls.some(([tex]) => tex === null)).toBe(false);
  });

  it('keeps the first picture on screen when it is replaced again before anything landed', async () => {
    const { stage, view, card } = await resident();
    const set = vi.spyOn(view, 'setTexture');
    stage.setPosterOverride('a', 'blob:p1');
    dom.drain();
    stage.setPosterOverride('a', 'blob:p2');
    dom.drain();
    expect(stage.tm.hasOutgoing(card)).toBe(true);
    expect(view.shown).toBeGreaterThanOrEqual(1);
    // The request for the first one was cancelled; only the second is asked for.
    land();
    dom.drain();
    expect(card.l1Url).toBe('blob:p2');
    expect(stage.posterShown('a')).toBe(true);
    expect(set.mock.calls.some(([tex]) => tex === null)).toBe(false);
  });

  it('goes back to the media of the element when the override is dropped, again without the placeholder', async () => {
    const { stage, view, card } = await resident();
    stage.setPosterOverride('a', 'blob:p1');
    dom.drain();
    land();
    dom.drain();
    const set = vi.spyOn(view, 'setTexture');
    stage.setPosterOverride('a', null);
    dom.drain();
    expect(card.l1Url).toBe('a.jpg');
    expect(view.shown).toBeGreaterThanOrEqual(1);
    land();
    dom.drain();
    expect(stage.posterShown('a')).toBe(true);
    expect(set.mock.calls.some(([tex]) => tex === null)).toBe(false);
  });

  it('lets go of the old picture when there is nothing to swap to', async () => {
    const { stage } = await boot([el('b', 0, 0, 200, 100, { thumbhash: HASH })]);
    dom.drain();
    // The card has no picture of its own: the override is its only one.
    stage.setPosterOverride('b', 'blob:p1');
    dom.drain();
    land();
    dom.drain();
    const view = stage.viewOf('b') as MediaView;
    const card = cardOf(stage, 'b');
    expect(view.shown).toBeGreaterThanOrEqual(1);
    stage.setPosterOverride('b', null);
    dom.drain();
    expect(card.l1Url).toBeUndefined();
    expect(stage.tm.hasOutgoing(card)).toBe(false);
    expect(view.shown).toBeLessThan(1);
  });

  it('keeps a card that is off screen from holding the old picture', async () => {
    const { stage, store } = await boot([el('far', 100000, 0)]);
    dom.drain();
    land();
    dom.drain();
    const card = cardOf(stage, 'far');
    stage.setPosterOverride('far', 'blob:p1');
    dom.drain();
    expect(card.l1Url).toBe('blob:p1');
    expect(stage.tm.hasOutgoing(card)).toBe(false);
    expect(stage.tm.has(card, 0)).toBe(true);
    void store;
  });

  it('is dropped with its element, and by a reload that no longer has it', async () => {
    const { stage, store } = await resident([el('a'), el('c', 300, 0)]);
    const posters = () => (stage as unknown as { posters: Map<string, string> }).posters;
    stage.setPosterOverride('a', 'blob:p1');
    stage.setPosterOverride('c', 'blob:p2');
    expect(posters().size).toBe(2);
    store.remove(['a']);
    dom.drain();
    expect(posters().has('a')).toBe(false);
    store.clear();
    store.add([el('d', 0, 0)], 'load');
    dom.drain();
    expect(posters().size).toBe(0);
  });
});

describe('Stage baked corner radius', () => {
  // A mounted card with its ThumbHash texture landed, 200 x 100.
  const landed = async () => {
    const { stage, store } = await boot([el('a')]);
    dom.drain();
    land();
    dom.drain();
    const card = cardOf(stage, 'a');
    expect(stage.tm.has(card, 0)).toBe(true);
    return { stage, store, card };
  };

  it('bakes again after a committed resize from 200 to 800 px', async () => {
    const { stage, store, card } = await landed();
    const asked = FakeWorker.all[0].loads.length;
    store.update('a', { w: 800, h: 400 });
    dom.drain();
    expect(card.w).toBe(800);
    expect(stage.tm.has(card, 0)).toBe(false);
    expect((stage.viewOf('a') as MediaView).shown).toBe(-1);
    // ... and asks the worker for the card again (it bakes the corners from the card's size when it starts).
    const again = FakeWorker.all[0].loads.slice(asked);
    expect(again.map((m) => m.level)).toContain(0);
  });

  it('keeps the textures for a change inside the tolerance, and counts it from the last bake', async () => {
    const { stage, store, card } = await landed();
    // An 8 px corner baked at 200 px is drawn at 8 * 215 / 200 = 8.6 px: under a pixel off.
    store.update('a', { w: 215, h: 107.5 });
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(true);
    // 230 is 1.2 px off the size it was baked at, though only 0.56 px off the last committed size.
    store.update('a', { w: 230, h: 115 });
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(false);
  });

  it('never bakes a square-cornered card again for its size', async () => {
    const { stage, store, card } = await landed();
    store.update('a', { radius: 0 });
    dom.drain();
    // The radius change itself is a new bake: land it, then resize a lot.
    land();
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(true);
    store.update('a', { w: 800, h: 400 });
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(true);
  });

  it('bakes again when the card is resized to another shape (the textures are cropped to it)', async () => {
    const { stage, store, card } = await landed();
    // 200 x 100 -> 200 x 150: same width, not the same shape.
    store.update('a', { w: 200, h: 150 });
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(false);
  });

  it('keeps the textures for a shape change under 1%, and for a square-cornered card too', async () => {
    const { stage, store, card } = await landed();
    store.update('a', { w: 200, h: 100.5 });
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(true);
    store.update('a', { radius: 0 });
    dom.drain();
    land();
    dom.drain();
    store.update('a', { w: 200, h: 150 });
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(false);
  });

  it('does not touch the textures during a live resize preview', async () => {
    const { stage, card } = await landed();
    for (const w of [300, 500, 800]) stage.setPreview('a', 0, 0, w, w / 2, 0);
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(true);
    expect(card.w).toBe(200);
    // Dropping the preview without a commit (a cancelled gesture) changes nothing either.
    stage.clearPreview('a');
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(true);
  });

  it('also for a card with no view', async () => {
    const { stage, store } = await boot([el('far', 100000, 0)]);
    dom.drain();
    land();
    dom.drain();
    const card = cardOf(stage, 'far');
    expect(stage.tm.has(card, 0)).toBe(true);
    store.update('far', { w: 800, h: 400 });
    dom.drain();
    expect(stage.tm.has(card, 0)).toBe(false);
  });
});

describe('Stage mounting before the first cull pass', () => {
  it('culls a big add made before any tick: only the cards near the view ever get a view', async () => {
    const { stage, store } = await boot();
    const many: Element[] = [];
    for (let i = 0; i < 3000; i++) many.push(el(`c${i}`, (i % 55) * 1000, Math.floor(i / 55) * 1000));
    store.add(many);
    dom.drain();
    const stats = stage.stats() as { mounted: number; mounts: number; mountQueue: number };
    expect(stage.isMounted('c0')).toBe(true);
    expect(stats.mounted).toBeGreaterThan(0);
    // The 800 x 600 view plus half a screen of overscan holds a couple of cards of this 1000 px grid. The
    // rest were never built (a pass that mounts all 3000 and then unmounts the strays ends up the same,
    // after a frame of 3000 views).
    expect(stats.mounts).toBeLessThan(10);
    expect(stats.mounted).toBe(stats.mounts);
    expect(stats.mountQueue).toBe(0);
  });
});

describe('Stage fit', () => {
  it('does nothing on an empty board, or for ids that match no card', async () => {
    const { stage, store } = await boot();
    dom.drain();
    stage.cam.jumpTo({ tx: 5, ty: 6, scale: 2 });
    stage.fit(false);
    stage.fit(true);
    stage.fitRect(() => stage.contentBounds([]), false);
    stage.fitRect(stage.contentBounds(['nope']), true);
    expect(stage.cam.cam).toEqual({ tx: 5, ty: 6, scale: 2 });
    expect(stage.cam.busy).toBe(false);
    // The public bounds keep their shape.
    expect(stage.contentBounds()).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
    // With a card it still fits.
    store.add([el('a', 1000, 1000, 400, 200)]);
    dom.drain();
    stage.fit(false);
    expect(stage.cam.cam).not.toEqual({ tx: 5, ty: 6, scale: 2 });
    expect(stage.cam.scale).toBeLessThanOrEqual(stage.cam.maxScale);
    // The card's centre (1200, 1100) is at the centre of the 800 x 600 view.
    expect(stage.worldToScreen(1200, 1100).x).toBeCloseTo(400, 3);
    expect(stage.worldToScreen(1200, 1100).y).toBeCloseTo(300, 3);
  });
});

describe('Stage theme', () => {
  it('takes the new theme\'s dot opacity at once, not at the next camera move', async () => {
    const { stage } = await boot([el('a')]);
    dom.drain();
    expect(inner(stage).bg.alpha).toBeCloseTo(DARK_THEME.dotAlpha!, 6);
    stage.setTheme(LIGHT_THEME);
    expect(inner(stage).bg.alpha).toBeCloseTo(LIGHT_THEME.dotAlpha!, 6);
  });
});

describe('Stage loop', () => {
  it('parks while the WebGL context is lost, and works again after the restore', async () => {
    const { stage } = await boot([el('a')]);
    dom.drain();
    stage.canvasEl.dispatchEvent(new Event('webglcontextlost'));
    expect(inner(stage).lost).toBe(true);
    // A decode lands: one frame to look at it, which cannot upload while lost.
    land();
    expect(stage.tm.pendingWork).toBe(true);
    expect(dom.frames.length).toBeGreaterThan(0);
    dom.runFrame();
    expect(stage.tm.pendingWork).toBe(true);
    expect(dom.frames).toHaveLength(0);
    // The settle pass (the parked loop's timer) does not wake it either.
    (stage as unknown as { settle: () => void }).settle();
    expect(dom.frames).toHaveLength(0);
    // Restored: every texture is rebuilt and the loop is running again.
    stage.canvasEl.dispatchEvent(new Event('webglcontextrestored'));
    expect(dom.frames.length).toBeGreaterThan(0);
    dom.drain();
    expect(stage.tm.pendingWork).toBe(false);
    expect(FakeWorker.all[0].loads.length).toBeGreaterThan(0);
  });

  describe('hooks', () => {
    it('reports a throwing frame hook once and never rebuilds the textures for it', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { stage } = await boot([el('a')]);
      dom.drain();
      const good = vi.fn();
      const bad = vi.fn(() => {
        throw new Error('boom');
      });
      stage.onFrame(bad);
      stage.onFrame(good);
      const reset = vi.spyOn(stage.tm, 'reset');
      const rendersBefore = fake.app!.renders;
      for (let i = 0; i < 4; i++) {
        stage.markDirty();
        dom.drain();
      }
      expect(bad.mock.calls.length).toBeGreaterThanOrEqual(4);
      // The hook after the failing one still runs, and the frame still renders.
      expect(good.mock.calls.length).toBe(bad.mock.calls.length);
      expect(fake.app!.renders - rendersBefore).toBeGreaterThanOrEqual(4);
      expect(reset).not.toHaveBeenCalled();
      expect(stage.stats().renderErrorsTotal).toBe(0);
      expect(inner(stage).counters.renderErrors).toBe(0);
      expect(inner(stage).counters.hookErrors).toBe(bad.mock.calls.length);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain('hook');
    });

    it('keeps the loop alive when a before-frame or a settle hook throws', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { stage } = await boot([el('a')]);
      dom.drain();
      const before = vi.fn(() => {
        throw new Error('before');
      });
      const settleHook = vi.fn(() => {
        throw new Error('settle');
      });
      const after = vi.fn();
      stage.onBeforeFrame(before);
      stage.onSettle(settleHook);
      stage.onSettle(after);
      const rendersBefore = fake.app!.renders;
      stage.markDirty();
      dom.drain();
      expect(fake.app!.renders).toBeGreaterThan(rendersBefore);
      (stage as unknown as { settle: () => void }).settle();
      expect(settleHook).toHaveBeenCalled();
      expect(after).toHaveBeenCalled();
    });
  });
});

describe('Stage device pixel ratio', () => {
  it('follows a change of devicePixelRatio, and arms the query again for the new value', async () => {
    const { stage } = await boot([el('a')]);
    dom.drain();
    const first = dom.mqs.at(-1)!;
    expect(first.query).toBe('(resolution: 1dppx)');
    expect(first.listeners.size).toBe(1);
    const overlay = vi.spyOn(stage.overlay, 'setDpr');
    fake.app!.resize.mockClear();
    const rendersBefore = fake.app!.renders;
    dom.setDpr(2);
    for (const l of [...first.listeners]) l();
    expect(stage.dprValue).toBe(2);
    expect(inner(stage).ctx.dpr).toBe(2);
    expect(overlay).toHaveBeenCalledWith(2);
    expect(fake.app!.resize).toHaveBeenCalledWith(800, 600, 2);
    // Resizing clears the drawing buffer: drawn again at once.
    expect(fake.app!.renders).toBeGreaterThan(rendersBefore);
    // The window is invalidated and the LOD pass asked for, then run by the next tick.
    expect(inner(stage).mountedWin).toBeNull();
    expect(dom.frames.length).toBeGreaterThan(0);
    dom.drain();
    expect(inner(stage).mountedWin).not.toBeNull();
    expect(stage.stats().dpr).toBe(2);
    // The old query is released, a new one watches 2x.
    expect(first.listeners.size).toBe(0);
    const second = dom.mqs.at(-1)!;
    expect(second.query).toBe('(resolution: 2dppx)');
    expect(second.listeners.size).toBe(1);
    // Back to 1x (the browser fires again): handled the same way.
    dom.setDpr(1);
    for (const l of [...second.listeners]) l();
    expect(stage.dprValue).toBe(1);
    expect(dom.mqs.at(-1)!.query).toBe('(resolution: 1dppx)');
    // Disposing drops the listener.
    const last = dom.mqs.at(-1)!;
    dispose(stage);
    expect(last.listeners.size).toBe(0);
  });

  it('re-reads it when the host is measured (browser zoom resizes the host too)', async () => {
    const { stage } = await boot([el('a')]);
    dom.drain();
    fake.app!.resize.mockClear();
    // Same size, new ratio.
    dom.setDpr(1.5);
    dom.resizeHost();
    expect(stage.dprValue).toBe(1.5);
    expect(fake.app!.resize).toHaveBeenCalledWith(800, 600, 1.5);
    // Nothing changed at all: no resize.
    fake.app!.resize.mockClear();
    dom.resizeHost();
    expect(fake.app!.resize).not.toHaveBeenCalled();
  });

  it('asks for a finer level when the ratio goes up', async () => {
    // 260 px wide at 1x is L2 (< 480 device px); at 3x it is 780 device px: L3.
    const { stage } = await boot([el('a', 0, 0, 260, 130)]);
    dom.drain();
    const levels = () => FakeWorker.all[0].loads.map((m) => m.level);
    expect(levels()).not.toContain(3);
    dom.setDpr(3);
    for (const l of [...dom.mqs.at(-1)!.listeners]) l();
    dom.drain();
    expect(levels()).toContain(3);
    expect(stage.dprValue).toBe(3);
  });
});

describe('Stage dot texture', () => {
  it('stays out of Pixi\'s global cache and is destroyed with the board', async () => {
    const created: HTMLCanvasElement[] = [];
    const make = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, o?: ElementCreationOptions) => {
      const e = make(tag, o);
      if (tag === 'canvas') created.push(e as HTMLCanvasElement);
      return e;
    }) as never);
    const { stage } = await boot([el('a')]);
    const dots = created.find((c) => c.width === 64 && c.height === 64);
    expect(dots).toBeDefined();
    expect(Cache.has(dots)).toBe(false);
    const tex = inner(stage).bg.texture;
    expect(tex.destroyed).toBe(false);
    dispose(stage);
    expect(tex.destroyed).toBe(true);
  });
});
