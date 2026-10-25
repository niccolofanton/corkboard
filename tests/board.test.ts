// @vitest-environment jsdom
// The board's persistence, change events, `batch`, typed `stats()` and `render` event, against a stub stage:
// `getSnapshot` / `loadSnapshot`, who made a change (`source`), what changed (`prev`, `props`), one event per
// batch. The net-diff, z-order and listener rules are in changes.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stages: [] as { setCamera: ReturnType<typeof vi.fn>; cam: { cam: { tx: number; ty: number; scale: number } } }[],
  options: null as Record<string, unknown> | null,
}));

vi.mock('../src/render/stage', () => ({
  GRID: 24,
  Stage: {
    async create(_host: HTMLElement, options: Record<string, unknown>) {
      h.options = options;
      const stage = {
        cam: {
          cam: { tx: 10, ty: 20, scale: 2 },
          scale: 2,
          width: 1280,
          height: 800,
          isEmpty: false,
          visibleRect: () => ({ x0: 0, y0: 0, x1: 1280, y1: 800 }),
        },
        attach: () => {},
        dispose: () => {},
        onFrame: () => () => {},
        onSettle: () => () => {},
        // What the interaction layer touches while a selection is set and cleared.
        requestFrame: () => {},
        overlay: { setSelection: () => {}, setHover: () => {}, setGuides: () => {}, setMarquee: () => {} },
        previewRectOf: () => undefined,
        activeTheme: () => 'dark',
        markDirty: () => {},
        setPosterOverride: () => {},
        posterShown: () => false,
        fitRect: vi.fn(),
        boundsOf: () => undefined,
        setCamera: vi.fn(),
        setScaleRange: vi.fn(),
        clearPreview: () => {},
        pin: () => {},
        stats: () => ({ cards: 0, mounted: 0 }),
      };
      h.stages.push(stage);
      return stage;
    },
  },
}));

import { Corkboard, type CorkboardEvents } from '../src/Corkboard';
import { CorkboardError } from '../src/errors';
import { getInternals } from '../src/internals';
import { BoardLayout } from '../src/BoardLayout';
import type { BoardSnapshot } from '../src/snapshot';

let host: HTMLElement;
beforeEach(() => {
  h.stages = [];
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const make = (o: Parameters<typeof Corkboard.create>[1] = {}) => Corkboard.create(host, o);
const stageOf = (i = h.stages.length - 1) => h.stages[i];

const card = (id: string, x = 0) => ({ id, x, y: 0, w: 100, h: 80, media: { src: `${id}.jpg` } });

function watch(board: Corkboard) {
  const events: CorkboardEvents['change'][] = [];
  board.on('change', (e) => events.push(e));
  return events;
}

describe('all(): draw order', () => {
  it('is bottom first, and follows a bring-to-front (insertion order is not the draw order)', async () => {
    const board = await make({ interaction: false });
    board.add([card('a'), card('b'), card('c')]);
    expect(board.all().map((e) => e.id)).toEqual(['a', 'b', 'c']);
    getInternals(board).store.bringToFront(['a']);
    expect(board.all().map((e) => e.id)).toEqual(['b', 'c', 'a']);
    board.dispose();
  });
});

describe('getSnapshot', () => {
  it('writes format, version and the cards in draw order, with the camera by default', async () => {
    const board = await make({ interaction: false });
    board.add([card('a'), card('b')]);
    getInternals(board).store.bringToFront(['a']);
    const s = board.getSnapshot();
    expect(s.format).toBe('corkboard');
    expect(s.version).toBe(1);
    expect(s.elements.map((e) => e.id)).toEqual(['b', 'a']);
    expect(s.camera).toEqual({ tx: 10, ty: 20, scale: 2 });
    expect('camera' in board.getSnapshot({ camera: false })).toBe(false);
    board.dispose();
  });

  it('drops blob: urls, turns a Uint8Array thumbhash into base64 and passes data by reference', async () => {
    const board = await make({ interaction: false });
    const data = { tag: 'x' };
    board.add([
      {
        ...card('a'),
        media: { src: 'blob:http://x/1', video: 'blob:http://x/2', sizes: { small: 'blob:http://x/3', medium: 'm.jpg' }, thumbhash: new Uint8Array([1, 2, 3, 4, 5]), color: '#112233' },
        data,
      },
      { ...card('b'), media: { src: 'https://x/b.jpg', thumbhash: 'AQIDBAU=' } },
    ]);
    const [a, b] = board.getSnapshot().elements;
    expect(a.media).toEqual({ sizes: { medium: 'm.jpg' }, thumbhash: 'AQIDBAU=', color: '#112233' });
    expect(a.data).toBe(data);
    expect(b.media).toEqual({ src: 'https://x/b.jpg', thumbhash: 'AQIDBAU=' });
    // The live card keeps its blob url.
    expect(board.get('a')?.media.src).toBe('blob:http://x/1');
    board.dispose();
  });

  it('leaves out runtime state: the snapshot holds only format, version, elements and camera', async () => {
    const board = await make({ interaction: false });
    board.add(card('a'));
    expect(Object.keys(board.getSnapshot()).sort()).toEqual(['camera', 'elements', 'format', 'version']);
    board.dispose();
  });
});

describe('loadSnapshot', () => {
  it('round trip: add, reorder, getSnapshot, stringify / parse, load into a fresh board gives the same cards in the same order', async () => {
    const a = await make({ interaction: false });
    a.add([
      { ...card('a'), rot: 15, locked: true, radius: 3, aspectLocked: false, data: { n: 1 } },
      { ...card('b', 200), media: { src: 'b.jpg', embed: { html: '<b>hi</b>', title: 't' } } },
      { ...card('c', 400), media: { src: 'c.jpg', video: 'c.mp4', thumbhash: 'AQIDBAU=', aspect: 0.5 } },
    ]);
    getInternals(a).store.bringToFront(['a']);
    const text = JSON.stringify(a.getSnapshot());

    const b = await make({ interaction: false });
    b.loadSnapshot(JSON.parse(text) as BoardSnapshot);
    expect(b.all()).toEqual(a.all());
    expect(b.all().map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(getInternals(b).store.ids()).toEqual(['b', 'c', 'a']);
    // And the snapshot of the loaded board is the one it was loaded from.
    expect(JSON.stringify(b.getSnapshot())).toBe(text);
    expect(stageOf().setCamera).toHaveBeenCalledWith({ tx: 10, ty: 20, scale: 2 });
    a.dispose();
    b.dispose();
  });

  it('keeps ids and positions as they are (nothing is auto-placed) and replaces what was there', async () => {
    const board = await make({ interaction: false });
    board.add([card('old1'), card('old2', 500)]);
    board.loadSnapshot({ format: 'corkboard', version: 1, elements: [{ ...card('n', 7000), kind: 'image', rot: 0, locked: false, radius: 8, aspectLocked: true }] });
    expect(board.all().map((e) => [e.id, e.x, e.y])).toEqual([['n', 7000, 0]]);
    expect(board.get('old1')).toBeUndefined();
    board.dispose();
  });

  it('fills fields a hand-written snapshot leaves out with the defaults of add', async () => {
    const board = await make({ interaction: false });
    board.loadSnapshot({ format: 'corkboard', version: 1, elements: [{ id: 'a', kind: 'image', x: 1, y: 2, w: 30, h: 40, media: { src: 'a.jpg' } } as never] });
    expect(board.get('a')).toMatchObject({ rot: 0, locked: false, aspectLocked: true, radius: 8 });
    board.dispose();
  });

  it('emits exactly one change, the net diff: new ids added, gone ids removed, same ids updated, unchanged left out', async () => {
    const board = await make({ interaction: false });
    board.add([card('a'), card('b'), card('c', 600)]);
    const events = watch(board);
    const full = { kind: 'image', rot: 0, locked: false, radius: 8, aspectLocked: true } as const;
    board.loadSnapshot({
      format: 'corkboard',
      version: 1,
      elements: [
        { ...card('a'), ...full },
        { ...card('c', 650), ...full },
        { ...card('z', 9), ...full },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('load');
    expect(events[0].added.map((e) => e.id)).toEqual(['z']);
    expect(events[0].removed.map((e) => e.id)).toEqual(['b']);
    expect(events[0].updated.map((u) => [u.el.id, u.props])).toEqual([['c', ['x']]]);
    // b was removed (it was above a); z is a pure append. Loading emits its order like any other change.
    expect(events[0].order).toEqual({ moved: [{ id: 'b', prevBelow: 'a', nextBelow: null }] });
    board.dispose();
  });

  it('loading the snapshot the board just wrote is no change at all (no event)', async () => {
    const board = await make({ interaction: false });
    board.add([
      { ...card('a'), data: { n: 1 } },
      { ...card('b', 200), media: { src: 'b.jpg', thumbhash: new Uint8Array([1, 2, 3, 4, 5]), sizes: { small: 's.jpg' }, embed: { url: 'https://x.test/p' } } },
    ]);
    const events = watch(board);
    board.loadSnapshot(board.getSnapshot());
    expect(events).toHaveLength(0);
    board.dispose();
  });

  it('camera: false, or a snapshot with no camera, leaves the camera alone', async () => {
    const board = await make({ interaction: false });
    const s = board.getSnapshot();
    board.loadSnapshot(s, { camera: false });
    const { camera: _c, ...noCam } = s;
    board.loadSnapshot(noCam as BoardSnapshot);
    expect(stageOf().setCamera).not.toHaveBeenCalled();
    board.loadSnapshot(s);
    expect(stageOf().setCamera).toHaveBeenCalledTimes(1);
    board.dispose();
  });

  it('clears the selection, and the selection event comes before the swap', async () => {
    const board = await make();
    board.add([card('a'), card('b')]);
    board.select(['a']);
    const order: string[] = [];
    board.on('selection', () => order.push('selection'));
    board.on('change', () => order.push('change'));
    board.loadSnapshot({ format: 'corkboard', version: 1, elements: [] });
    expect(board.selection).toEqual([]);
    expect(order).toEqual(['selection', 'change']);
    board.dispose();
  });

  it('ends a running layout animation first', async () => {
    const board = await make({ interaction: false });
    const cancel = vi.spyOn(BoardLayout.prototype, 'cancelAnimation');
    board.loadSnapshot(board.getSnapshot());
    expect(cancel).toHaveBeenCalledTimes(1);
    cancel.mockRestore();
    board.dispose();
  });

  describe('is atomic: a bad snapshot throws invalid and changes nothing', () => {
    const el = (o: Record<string, unknown> = {}) => ({ ...card('x'), kind: 'image', rot: 0, locked: false, radius: 8, aspectLocked: true, ...o });
    const snap = (elements: unknown[], o: Record<string, unknown> = {}) => ({ format: 'corkboard', version: 1, elements, ...o }) as unknown as BoardSnapshot;
    const bad: [string, () => BoardSnapshot, RegExp][] = [
      ['not an object', () => null as never, /object/],
      ['wrong format', () => snap([], { format: 'nope' }), /format/],
      ['newer version', () => snap([], { version: 2 }), /written by a newer corkboard \(v2\); this build reads up to v1/],
      ['version 0', () => snap([], { version: 0 }), /version/],
      ['version not a number', () => snap([], { version: '1' }), /version/],
      ['elements not an array', () => snap({} as never), /array/],
      ['bad camera', () => snap([], { camera: { scale: 0, tx: 0, ty: 0 } }), /camera/],
      ['NaN x', () => snap([el({ id: 'ok' }), el({ id: 'n', x: NaN })]), /x must/],
      ['missing y', () => snap([el({ id: 'n', y: undefined })]), /y must/],
      ['w <= 0', () => snap([el({ id: 'n', w: 0 })]), /w must/],
      ['h <= 0', () => snap([el({ id: 'n', h: -1 })]), /h must/],
      ['duplicate id', () => snap([el({ id: 'd' }), el({ id: 'd' })]), /duplicate/],
      ['empty id', () => snap([el({ id: '' })]), /id/],
      ['unknown kind', () => snap([el({ id: 'k', kind: 'sound' })]), /kind/],
      ['bad media', () => snap([el({ id: 'm', media: null })]), /media/],
      ['bad embed', () => snap([el({ id: 'e', media: { embed: { url: 'u', html: 'h' } } })]), /embed/],
      ['numeric thumbhash', () => snap([el({ id: 't', media: { src: 'a', thumbhash: [1, 2] } })]), /thumbhash/],
    ];
    it.each(bad)('%s', async (_name, make_, re) => {
      const board = await make({ interaction: false });
      board.add([card('a'), card('b')]);
      const before = board.getSnapshot();
      const events = watch(board);
      const cam = stageOf().setCamera;
      let err: unknown;
      try {
        board.loadSnapshot(make_());
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CorkboardError);
      expect((err as CorkboardError).code).toBe('invalid');
      expect((err as CorkboardError).message).toMatch(re);
      expect(board.getSnapshot()).toEqual(before);
      expect(events).toHaveLength(0);
      expect(cam).not.toHaveBeenCalled();
      board.dispose();
    });

    it('keeps the selection too', async () => {
      const board = await make();
      board.add(card('a'));
      board.select(['a']);
      expect(() => board.loadSnapshot({ format: 'x' } as never)).toThrow(CorkboardError);
      expect(board.selection).toEqual(['a']);
      board.dispose();
    });
  });
});

describe('change event', () => {
  it('source is "api" for every call on the board and on board.layout', async () => {
    const board = await make({ interaction: false });
    const events = watch(board);
    board.add([card('a'), card('b', 300)]);
    board.update('a', { x: 50 });
    board.layout.tidy(undefined, { animate: false });
    board.remove('b');
    board.clear();
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.map((e) => e.source)).toEqual(events.map(() => 'api'));
    board.dispose();
  });

  it('source is "user" for a store write made by a gesture and "load" for loadSnapshot', async () => {
    const board = await make({ interaction: false });
    board.add(card('a'));
    const events = watch(board);
    getInternals(board).store.update('a', { x: 5 }, 'user');
    board.loadSnapshot({ ...board.getSnapshot(), elements: [] });
    expect(events.map((e) => e.source)).toEqual(['user', 'load']);
    board.dispose();
  });

  it('updated carries el, prev and props; a z-order change is on `order`, not in `updated`', async () => {
    const board = await make({ interaction: false });
    board.add([card('a'), card('b', 300)]);
    const events = watch(board);
    board.update('a', { x: 40, rot: 10 });
    const u = events[0].updated[0];
    expect(u.el).toMatchObject({ id: 'a', x: 40, rot: 10 });
    expect(u.prev).toMatchObject({ id: 'a', x: 0, rot: 0 });
    expect([...u.props].sort()).toEqual(['rot', 'x']);
    expect(u.el).toBe(board.get('a'));

    getInternals(board).store.bringToFront(['a'], 'user');
    expect(events[1].source).toBe('user');
    expect(events[1].updated).toEqual([]);
    expect(events[1].order).toEqual({ moved: [{ id: 'a', prevBelow: null, nextBelow: 'b' }] });
    board.dispose();
  });

  it('several updates of a card in a batch fold into one entry: first prev, last el, all props', async () => {
    const board = await make({ interaction: false });
    board.add(card('a'));
    const events = watch(board);
    board.batch(() => {
      board.update('a', { x: 1 });
      getInternals(board).store.bringToFront(['a']);
      board.update('a', { y: 2, x: 3 });
    });
    expect(events).toHaveLength(1);
    expect(events[0].updated).toHaveLength(1);
    const u = events[0].updated[0];
    expect(u.prev).toMatchObject({ x: 0, y: 0 });
    expect(u.el).toMatchObject({ x: 3, y: 2 });
    expect([...u.props].sort()).toEqual(['x', 'y']);
    board.dispose();
  });
});

describe('batch', () => {
  it('emits one change for everything inside, nested batches included', async () => {
    const board = await make({ interaction: false });
    board.add(card('keep'));
    const events = watch(board);
    board.batch(() => {
      board.add([card('a', 100), card('b', 300)]);
      board.batch(() => {
        board.update('a', { x: 9 });
        board.remove('keep');
      });
      // Reads inside see the changes already.
      expect(board.size).toBe(2);
      expect(board.get('a')?.x).toBe(9);
      expect(events).toHaveLength(0);
    });
    expect(events).toHaveLength(1);
    expect(events[0].added.map((e) => e.id)).toEqual(['a', 'b']);
    expect(events[0].removed.map((e) => e.id)).toEqual(['keep']);
    // `a` was added and then updated in the batch: one add, with the final card.
    expect(events[0].added[0].x).toBe(9);
    expect(events[0].updated).toEqual([]);
    board.dispose();
  });

  it('emits nothing when nothing changed', async () => {
    const board = await make({ interaction: false });
    const events = watch(board);
    board.batch(() => {});
    expect(events).toHaveLength(0);
    board.dispose();
  });

  it('on a throw keeps what was done, still emits the event for it, and rethrows', async () => {
    const board = await make({ interaction: false });
    const events = watch(board);
    const boom = new Error('boom');
    expect(() =>
      board.batch(() => {
        board.add(card('a'));
        throw boom;
      }),
    ).toThrow(boom);
    expect(board.get('a')).toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0].added.map((e) => e.id)).toEqual(['a']);
    // A failing validation inside is the same: the earlier add stays, the bad one added nothing.
    expect(() =>
      board.batch(() => {
        board.add(card('b', 300));
        board.add({ ...card('c'), w: NaN });
      }),
    ).toThrow(CorkboardError);
    expect(board.all().map((e) => e.id)).toEqual(['a', 'b']);
    expect(events).toHaveLength(2);
    board.dispose();
  });

  it('adding 2000 unplaced cards in one add stays quick', async () => {
    const board = await make({ interaction: false });
    const t = performance.now();
    board.batch(() => board.add(Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, media: { src: `${i}.jpg` } }))));
    expect(board.size).toBe(2000);
    expect(performance.now() - t).toBeLessThan(5000);
    board.dispose();
  });
});

describe('stats()', () => {
  it('adds the embed and video groups to what the stage reports', async () => {
    const board = await make({ interaction: false });
    const s = board.stats();
    expect(s).toMatchObject({ cards: 0, mounted: 0 });
    expect(Object.keys(s.embeds).sort()).toEqual(
      ['active', 'animating', 'animatingBudget', 'culled', 'freezeThreshold', 'frozen', 'interacting', 'live', 'loading', 'maxLive', 'parked', 'previewsPending'],
    );
    for (const [k, v] of Object.entries(s.embeds)) {
      if (k === 'interacting') expect(v).toBeNull();
      else expect(typeof v, k).toBe('number');
    }
    expect(s.video).toEqual({ playing: 0, budget: expect.any(Number) });
    expect(s.embeds.maxLive).toBe(getInternals(board).embeds.maxLive);
    expect(s.embeds.live).toBe(getInternals(board).embeds.live.size);
    board.dispose();
  });
});

describe('render event', () => {
  it('forwards what the stage reports for a frame', async () => {
    const board = await make({ interaction: false });
    const seen: { cpuMs: number; gpuMs: readonly number[] }[] = [];
    board.on('render', (e) => seen.push(e));
    const onRender = h.options!.onRender as (e: { cpuMs: number; gpuMs: readonly number[] }) => void;
    onRender({ cpuMs: 1.5, gpuMs: [] });
    onRender({ cpuMs: 2, gpuMs: [0.4, 0.5] });
    expect(seen).toEqual([
      { cpuMs: 1.5, gpuMs: [] },
      { cpuMs: 2, gpuMs: [0.4, 0.5] },
    ]);
    board.dispose();
  });
});

describe('Corkboard.clearPreviewCache', () => {
  it('deletes the named cache, or the default ones, and never throws', async () => {
    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: del });
    await Corkboard.clearPreviewCache('mine');
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('mine');
    del.mockClear();
    await expect(Corkboard.clearPreviewCache()).resolves.toBeUndefined();
    expect(del.mock.calls.length).toBeGreaterThanOrEqual(1);
    del.mockRejectedValue(new Error('denied'));
    await expect(Corkboard.clearPreviewCache('x')).resolves.toBeUndefined();
  });
});

describe('after dispose', () => {
  it('batch, getSnapshot and load throw "disposed"', async () => {
    const board = await make({ interaction: false });
    const s = board.getSnapshot();
    board.dispose();
    for (const call of [() => board.batch(() => {}), () => board.getSnapshot(), () => board.loadSnapshot(s)]) {
      expect(call).toThrow(expect.objectContaining({ code: 'disposed' }));
    }
  });

  describe('members and internals', () => {
    it('getInternals gives the parts the type hides, on a working board', async () => {
      const board = await make();
      const { stage, store, interaction, embeds, video } = getInternals(board);
      expect(store.size).toBe(0);
      expect(stage).toBeTruthy();
      expect(interaction).toBeTruthy();
      expect(embeds.live.size).toBe(0);
      expect(video.playing.size).toBe(0);
      board.add({ id: 'a', x: 0, y: 0, w: 10, h: 10, media: { src: 'a.jpg' } });
      expect(store.has('a')).toBe(true);
      board.dispose();
      expect(getInternals(board).store).toBe(store);
    });

    it('the interaction part is null without interaction', async () => {
      const board = await make({ interaction: false });
      expect(board.interaction).toBeNull();
      expect(getInternals(board).interaction).toBeNull();
      board.dispose();
    });

    it('board.embeds and board.interaction expose only their small interfaces', async () => {
      const board = await make();
      expect(Object.keys(board.embeds).sort()).toEqual(['exitInteract', 'info', 'interact', 'interacting', 'live', 'setOptions']);
      expect(Object.keys(board.interaction!).sort()).toEqual(['setOptions', 'setPanMode']);
      const { embeds } = getInternals(board);
      expect(board.embeds.live).toEqual(embeds.live);
      expect(board.embeds.interacting).toBeNull();
      expect(board.embeds.info('ghost')).toBeUndefined();
      expect(board.embeds.interact('ghost')).toBe(false);
      board.dispose();
      expect(() => board.interaction!.setPanMode(true)).toThrow(CorkboardError);
      expect(() => board.embeds.exitInteract()).toThrow(CorkboardError);
    });
  });
});
