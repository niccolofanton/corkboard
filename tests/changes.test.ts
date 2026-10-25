// @vitest-environment jsdom
// The board's change contract against a stub stage: the event is the NET diff per id, the draw order travels in
// `order`, `source` and nesting rules, listener isolation, overlays on /unstable, snapshot validation and
// copies, the namespaces and the nullability rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  frame: [] as ((camChanged: boolean) => void)[],
  settle: [] as (() => void)[],
  stage: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));

vi.mock('../src/render/stage', () => ({
  GRID: 24,
  Stage: {
    async create() {
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
        onFrame: (fn: (c: boolean) => void) => {
          h.frame.push(fn);
          return () => void h.frame.splice(h.frame.indexOf(fn), 1);
        },
        onSettle: (fn: () => void) => {
          h.settle.push(fn);
          return () => void h.settle.splice(h.settle.indexOf(fn), 1);
        },
        requestFrame: () => {},
        overlay: { setSelection: () => {}, setHover: () => {}, setGuides: () => {}, setMarquee: () => {} },
        previewRectOf: () => undefined,
        activeTheme: () => 'dark',
        markDirty: () => {},
        fitRect: vi.fn(),
        boundsOf: vi.fn(() => undefined),
        setCamera: vi.fn(),
        setScaleRange: vi.fn(),
        worldToScreen: (x: number, y: number) => ({ x: 10 + x * 2, y: 20 + y * 2 }),
        clearPreview: () => {},
        pin: () => {},
        stats: () => ({ cards: 0, mounted: 0 }),
      };
      h.stage = stage as never;
      return stage;
    },
  },
}));

import { Corkboard, type CorkboardEvents } from '../src/Corkboard';
import { CorkboardError } from '../src/errors';
import { getInternals } from '../src/internals';
import { addOverlay } from '../src/overlay';
import type { BoardSnapshot } from '../src/snapshot';
import type { CardInit } from '../src/types';

let host: HTMLElement;
beforeEach(() => {
  h.frame = [];
  h.settle = [];
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

const make = (o: Parameters<typeof Corkboard.create>[1] = {}) => Corkboard.create(host, o);
const card = (id: string, x = 0): CardInit & { id: string } => ({ id, x, y: 0, w: 100, h: 80, media: { src: `${id}.jpg` } });
const ids = (l: readonly { id: string }[]) => l.map((e) => e.id);
const order = (b: Corkboard) => b.all().map((e) => e.id);

function watch(board: Corkboard) {
  const events: CorkboardEvents['change'][] = [];
  board.on('change', (e) => events.push(e));
  return events;
}

describe('change: the net diff per id', () => {
  it('add then remove in one batch is nothing; no event', async () => {
    const board = await make({ interaction: false });
    const events = watch(board);
    board.batch(() => {
      board.add(card('a'));
      board.remove('a');
    });
    expect(events).toEqual([]);
    board.dispose();
  });

  it('remove then add of the same id is one update, prev to el, with the fields that differ', async () => {
    const board = await make({ interaction: false });
    board.add([card('a'), card('b', 200)]);
    const before = board.get('a')!;
    const events = watch(board);
    board.batch(() => {
      board.remove('a');
      board.add({ ...card('a'), x: 50, locked: true });
    });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect([e.added, e.removed]).toEqual([[], []]);
    expect(e.updated).toHaveLength(1);
    expect(e.updated[0].prev).toBe(before);
    expect(e.updated[0].el).toBe(board.get('a'));
    // `media` was replaced as a whole (a new object): it counts, equal contents or not.
    expect([...e.updated[0].props].sort()).toEqual(['locked', 'media', 'x']);
    // [a, b] -> [b, a]: the minimal set is one card (b goes to the bottom).
    expect(e.order).toEqual({ moved: [{ id: 'b', prevBelow: 'a', nextBelow: null }] });
    board.dispose();
  });

  it('add then update is one add with the final card', async () => {
    const board = await make({ interaction: false });
    const events = watch(board);
    board.batch(() => {
      board.add(card('a'));
      board.update('a', { x: 77 });
      board.update('a', { y: 5 });
    });
    expect(ids(events[0].added)).toEqual(['a']);
    expect(events[0].added[0]).toMatchObject({ x: 77, y: 5 });
    expect(events[0].updated).toEqual([]);
    board.dispose();
  });

  it('a card that ends as it began (A to B to A) is dropped, and an empty batch emits nothing', async () => {
    const board = await make({ interaction: false });
    board.add(card('a'));
    const events = watch(board);
    board.batch(() => {
      board.update('a', { x: 9 });
      board.update('a', { x: 0 });
    });
    board.batch(() => {});
    board.update('a', { x: 0 });
    expect(events).toEqual([]);
    board.dispose();
  });

  it('an id is never in two of added, removed, updated', async () => {
    const board = await make({ interaction: false });
    board.add([card('a'), card('b'), card('c')]);
    const events = watch(board);
    board.batch(() => {
      board.remove('a');
      board.add(card('a', 5));
      board.update('b', { x: 1 });
      board.remove('b');
      board.add(card('n'));
      board.update('n', { x: 1 });
      board.remove('c');
    });
    const e = events[0];
    const all = [...ids(e.added), ...ids(e.removed), ...e.updated.map((u) => u.el.id)];
    expect(new Set(all).size).toBe(all.length);
    expect(ids(e.added)).toEqual(['n']);
    expect(ids(e.removed).sort()).toEqual(['b', 'c']);
    expect(e.updated.map((u) => u.el.id)).toEqual(['a']);
    board.dispose();
  });
});

describe('z-order', () => {
  it('bringToFront, sendToBack and setOrder emit `order` (and nothing in updated); no-ops emit nothing', async () => {
    const board = await make({ interaction: false });
    board.add([card('a'), card('b'), card('c')]);
    const events = watch(board);
    board.bringToFront('a');
    expect(order(board)).toEqual(['b', 'c', 'a']);
    board.sendToBack(['a', 'ghost']);
    expect(order(board)).toEqual(['a', 'b', 'c']);
    board.setOrder(['c', 'b', 'a']);
    expect(order(board)).toEqual(['c', 'b', 'a']);
    expect(events.map((e) => e.order)).toEqual([
      { moved: [{ id: 'a', prevBelow: null, nextBelow: 'c' }] },
      { moved: [{ id: 'a', prevBelow: 'c', nextBelow: null }] },
      // setOrder: the minimal set (c and b left the run a < b < c; the longest run that stayed is one card).
      { moved: [{ id: 'c', prevBelow: 'b', nextBelow: null }, { id: 'b', prevBelow: 'a', nextBelow: 'c' }] },
    ]);
    expect(events.every((e) => e.updated.length === 0 && e.source === 'api')).toBe(true);
    board.setOrder(['c', 'b', 'a']);
    board.bringToFront(['a']);
    board.bringToFront(['ghost']);
    expect(events).toHaveLength(3);
    board.dispose();
  });

  it('setOrder needs an exact permutation of the ids on the board, else throws invalid', async () => {
    const board = await make({ interaction: false });
    board.add([card('a'), card('b')]);
    const events = watch(board);
    for (const bad of [['a'], ['a', 'b', 'c'], ['a', 'a'], ['a', 'z'], []]) {
      expect(() => board.setOrder(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
    expect(order(board)).toEqual(['a', 'b']);
    expect(events).toEqual([]);
    board.dispose();
  });

  it('a removal carries `order`; a pure append does not; `add` has no index option', async () => {
    const board = await make({ interaction: false });
    const events = watch(board);
    board.add([card('a'), card('b')]);
    board.add(card('c'));
    board.remove('b');
    expect(events.map((e) => e.order)).toEqual([undefined, undefined, { moved: [{ id: 'b', prevBelow: 'a', nextBelow: null }] }]);
    board.dispose();
  });
});

describe('source', () => {
  it('batch tags the event; the outermost named source wins, "load" wins over any, library writes are "system"', async () => {
    const board = await make({ interaction: false });
    board.add(card('a'));
    const events = watch(board);
    board.batch(() => board.update('a', { x: 1 }), { source: 'remote' });
    board.batch(() => {
      board.batch(() => board.update('a', { x: 2 }), { source: 'inner' });
    }, { source: 'outer' });
    board.batch(() => board.update('a', { x: 3 }));
    board.batch(
      () => {
        board.update('a', { x: 4 });
        board.loadSnapshot({ ...board.getSnapshot(), elements: [] });
      },
      { source: 'remote' },
    );
    getInternals(board).store.update('a', { x: 5 }, 'system');
    expect(events.map((e) => e.source)).toEqual(['remote', 'outer', 'api', 'load']);
    board.add(card('b'));
    getInternals(board).store.update('b', { x: 5 }, 'system');
    expect(events.at(-1)?.source).toBe('system');
    board.dispose();
  });
});

describe('listener isolation', () => {
  it('a change listener that throws does not break the others, the selection or the store', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const board = await make();
    board.add([card('a'), card('b', 200)]);
    board.select(['a', 'b']);
    const seen: { selection: readonly string[] }[] = [];
    const boom = new Error('host bug');
    board.on('change', () => {
      throw boom;
    });
    board.on('change', () => seen.push({ selection: [...board.selection] }));
    const sel = vi.fn();
    board.on('selection', sel);
    board.remove('a');
    // The interaction layer had already dropped the removed card when host code ran.
    expect(seen).toEqual([{ selection: ['b'] }]);
    expect(board.selection).toEqual(['b']);
    expect(sel).toHaveBeenCalledWith({ ids: ['b'] });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('"change" listener'), boom);
    // A throwing `selection` listener does not stop the next one either.
    board.on('selection', () => {
      throw boom;
    });
    const after = vi.fn();
    board.on('selection', after);
    board.select([]);
    expect(after).toHaveBeenCalledTimes(1);
    board.dispose();
  });

  it('batch rethrows the error of fn, even when a listener throws too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const board = await make({ interaction: false });
    board.on('change', () => {
      throw new Error('listener');
    });
    const fnErr = new Error('fn');
    expect(() =>
      board.batch(() => {
        board.add(card('a'));
        throw fnErr;
      }),
    ).toThrow(fnErr);
    expect(board.get('a')).toBeDefined();
    board.dispose();
  });
});

describe('addOverlay (unstable)', () => {
  const overlay = () => ({ onFrame: vi.fn(), onSettle: vi.fn(), dispose: vi.fn() });

  it('works after create: gets the context, the frame and settle ticks, and returns a disposer', async () => {
    const board = await make({ interaction: false });
    const o = overlay();
    const factory = vi.fn((_ctx: unknown) => o);
    const off = addOverlay(board, factory);
    const ctx = factory.mock.calls[0][0] as { root: HTMLElement; store: unknown; stage: unknown };
    const parts = getInternals(board);
    expect(ctx.root).toBe(parts.overlayRoot);
    expect(host.contains(ctx.root)).toBe(true);
    expect([ctx.store, ctx.stage]).toEqual([parts.store, parts.stage]);
    h.frame.forEach((f) => f(true));
    h.settle.forEach((f) => f());
    expect(o.onFrame).toHaveBeenCalledWith(true);
    expect(o.onSettle).toHaveBeenCalledTimes(1);

    off();
    off();
    expect(o.dispose).toHaveBeenCalledTimes(1);
    h.frame.forEach((f) => f(false));
    expect(o.onFrame).toHaveBeenCalledTimes(1);
    // The board's own teardown does not dispose it again.
    board.dispose();
    expect(o.dispose).toHaveBeenCalledTimes(1);
  });

  it('board.dispose() tears down the overlays that are still there; adding after dispose throws', async () => {
    const board = await make({ interaction: false });
    const a = overlay();
    const b = overlay();
    addOverlay(board, () => a);
    const offB = addOverlay(board, () => b);
    offB();
    board.dispose();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(() => addOverlay(board, overlay)).toThrow(expect.objectContaining({ code: 'disposed' }));
  });

  it('a factory that throws adds nothing', async () => {
    const board = await make({ interaction: false });
    const boom = new Error('factory');
    const frames = h.frame.length;
    expect(() =>
      addOverlay(board, () => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(h.frame).toHaveLength(frames);
    board.dispose();
  });

  it('CorkboardOptions has no `overlays`', async () => {
    // @ts-expect-error the option moved to addOverlay
    const board = await make({ interaction: false, overlays: [] });
    board.dispose();
  });
});

describe('snapshot: validation is the same for add and loadSnapshot', () => {
  const inits: [string, Record<string, unknown>][] = [
    ['plain', {}],
    ['rot, locked, aspectLocked, radius', { rot: 10, locked: true, aspectLocked: false, radius: 0 }],
    ['video', { kind: 'video', media: { src: 'a.jpg', video: 'a.mp4', aspect: 0.5 } }],
    ['embed url', { kind: 'embed', media: { embed: { url: 'https://x.test/p', title: 't', resolution: '1080p' } } }],
    ['embed html', { media: { embed: { html: '<b>x</b>' } } }],
    ['base64 thumbhash', { media: { src: 'a.jpg', thumbhash: 'AQIDBAU=' } }],
    ['unpadded thumbhash', { media: { src: 'a.jpg', thumbhash: 'AQIDBAU' } }],
    ['bytes thumbhash', { media: { src: 'a.jpg', thumbhash: new Uint8Array([1, 2, 3, 4, 5]) } }],
    ['sizes and color', { media: { src: 'a.jpg', sizes: { small: 's', large: 'l' }, color: '#112233' } }],
    ['data', { data: { any: ['thing'] } }],
  ];
  const wrong: [string, Record<string, unknown>, RegExp][] = [
    ['kind', { kind: 'sound' }, /kind/],
    ['locked', { locked: 'yes' }, /locked/],
    ['aspectLocked', { aspectLocked: 1 }, /aspectLocked/],
    ['thumbhash number array', { media: { src: 'a', thumbhash: [1, 2] } }, /thumbhash/],
    ['thumbhash garbage', { media: { src: 'a', thumbhash: 'not base64!' } }, /thumbhash/],
    ['thumbhash empty', { media: { src: 'a', thumbhash: '' } }, /thumbhash/],
    ['x NaN', { x: NaN }, /x must/],
    ['w 0', { w: 0 }, /w must/],
    ['rot Infinity', { rot: Infinity }, /rot must/],
    ['radius -1', { radius: -1 }, /radius must/],
    ['aspect 0', { media: { src: 'a', aspect: 0 } }, /aspect/],
    ['embed both', { media: { embed: { url: 'u', html: 'h' } } }, /embed/],
    ['embed neither', { media: { embed: {} } }, /embed/],
    ['media null', { media: null }, /media/],
  ];

  it.each(inits)('accepted by add, accepted by loadSnapshot: %s', async (_n, over) => {
    const board = await make({ interaction: false });
    board.add({ ...card('a'), ...over } as CardInit);
    const snap = JSON.parse(JSON.stringify(board.getSnapshot())) as BoardSnapshot;
    const other = await make({ interaction: false });
    expect(() => other.loadSnapshot(snap)).not.toThrow();
    expect(other.get('a')).toMatchObject({ id: 'a', x: 0, y: 0, w: 100, h: 80 });
    // And a snapshot straight from getSnapshot (bytes become base64) loads too.
    expect(() => other.loadSnapshot(board.getSnapshot())).not.toThrow();
    board.dispose();
    other.dispose();
  });

  it.each(wrong)('rejected by add AND by loadSnapshot: %s', async (_n, over, re) => {
    const board = await make({ interaction: false });
    const bad = { ...card('a'), ...over };
    expect(() => board.add(bad as CardInit)).toThrow(expect.objectContaining({ code: 'invalid', message: expect.stringMatching(re) }));
    board.add(card('keep'));
    const full = { kind: 'image', rot: 0, locked: false, radius: 8, aspectLocked: true };
    const snap = { format: 'corkboard', version: 1, elements: [{ ...full, ...bad }] } as unknown as BoardSnapshot;
    expect(() => board.loadSnapshot(snap)).toThrow(expect.objectContaining({ code: 'invalid', message: expect.stringMatching(re) }));
    // update takes the same fields (but for the ones only a whole card has).
    if (!('media' in over) || over.media !== null) {
      expect(() => board.update('keep', over as never)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
    expect(order(board)).toEqual(['keep']);
    board.dispose();
  });

  it('load additionally requires x, y, w and h', async () => {
    const board = await make({ interaction: false });
    const full = { kind: 'image', media: { src: 'a' } };
    for (const missing of ['x', 'y', 'w', 'h']) {
      const el: Record<string, unknown> = { id: 'a', x: 0, y: 0, w: 1, h: 1, ...full };
      delete el[missing];
      const snap = { format: 'corkboard', version: 1, elements: [el] } as unknown as BoardSnapshot;
      expect(() => board.loadSnapshot(snap), missing).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
    board.dispose();
  });

  it('exports the version and refuses a newer one with a message that says so', async () => {
    const { SNAPSHOT_VERSION } = await import('../src/snapshot');
    expect(SNAPSHOT_VERSION).toBe(1);
    const board = await make({ interaction: false });
    expect(board.getSnapshot().version).toBe(SNAPSHOT_VERSION);
    const newer = { format: 'corkboard', version: 7, elements: [] } as unknown as BoardSnapshot;
    expect(() => board.loadSnapshot(newer)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: expect.stringContaining('written by a newer corkboard (v7); this build reads up to v1'),
      }),
    );
    board.dispose();
  });

  it('drops keys a card does not have', async () => {
    const board = await make({ interaction: false });
    const snap = {
      format: 'corkboard',
      version: 1,
      extra: 1,
      elements: [{ id: 'a', kind: 'image', x: 0, y: 0, w: 5, h: 5, media: { src: 'a', junk: 1 }, selected: true, zIndex: 3 }],
    } as unknown as BoardSnapshot;
    board.loadSnapshot(snap);
    expect(Object.keys(board.get('a')!).sort()).toEqual(
      ['aspectLocked', 'data', 'h', 'id', 'kind', 'locked', 'media', 'radius', 'rot', 'w', 'x', 'y'],
    );
    expect(board.get('a')!.media).toEqual({ src: 'a' });
    board.dispose();
  });

  it('shares no object with the board: media is copied both ways, data stays by reference', async () => {
    const board = await make({ interaction: false });
    const data = { tag: 1 };
    board.add({
      ...card('a'),
      data,
      media: { src: 'a.jpg', sizes: { small: 's.jpg' }, embed: { url: 'https://x.test/' }, thumbhash: new Uint8Array([1, 2, 3, 4, 5]) },
    });
    const live = board.get('a')!;
    const snap = board.getSnapshot();
    const m = snap.elements[0].media;
    expect(m).not.toBe(live.media);
    expect(m.sizes).not.toBe(live.media.sizes);
    expect(m.embed).not.toBe(live.media.embed);
    expect(snap.elements[0].data).toBe(data);
    // Mutating the snapshot leaves the board alone.
    m.sizes!.small = 'changed';
    (m.embed as { url: string }).url = 'changed';
    m.src = 'changed';
    expect(board.get('a')!.media).toMatchObject({ src: 'a.jpg', sizes: { small: 's.jpg' }, embed: { url: 'https://x.test/' } });
    // A Uint8Array thumbhash is stored as base64: the caller's bytes are not the board's.
    expect(live.media.thumbhash).toBe('AQIDBAU=');

    // And the other way: the board keeps nothing of the snapshot it was loaded from.
    const other = await make({ interaction: false });
    const text = JSON.parse(JSON.stringify(board.getSnapshot())) as BoardSnapshot;
    other.loadSnapshot(text);
    text.elements[0].media.sizes!.small = 'mutated';
    (text.elements[0].media.embed as { url: string }).url = 'mutated';
    expect(other.get('a')!.media.sizes).toEqual({ small: 's.jpg' });
    expect(other.get('a')!.media.embed).toEqual({ url: 'https://x.test/' });
    const withData = board.getSnapshot();
    other.loadSnapshot(withData);
    // Equal to what the board holds: the board keeps its own object (no phantom update).
    expect(other.get('a')!.data).toEqual(data);
    // A different one is taken by reference.
    const changed = { tag: 2 };
    withData.elements[0].data = changed;
    other.loadSnapshot(withData);
    expect(other.get('a')!.data).toBe(changed);
    board.dispose();
    other.dispose();
  });
});

describe('namespaces', () => {
  it('the video, embeds and interaction setters are on their namespaces, and gone from the root', async () => {
    const board = await make();
    for (const gone of ['setVideo', 'setVideoPaused', 'playing', 'videoBudget', 'setEmbeds', 'arrangeTargets', 'clearSelection', 'toJSON', 'load']) {
      expect(gone in board, gone).toBe(false);
    }
    expect(Object.keys(board.video).sort()).toEqual(['budget', 'paused', 'playing', 'setOptions', 'setPaused']);
    const { video, embeds } = getInternals(board);
    expect(board.video.playing).toEqual(video.playing);
    expect(board.video.budget).toBe(video.playingBudget);
    expect(board.video.paused).toBe(false);
    board.video.setPaused(true);
    expect(board.video.paused).toBe(true);
    board.video.setPaused(false);
    expect(board.video.paused).toBe(false);
    const setV = vi.spyOn(video, 'setOptions');
    board.video.setOptions({ mode: 'off' });
    expect(setV).toHaveBeenCalledWith({ mode: 'off' });
    const setE = vi.spyOn(embeds, 'setOptions');
    board.embeds.setOptions({ resolution: '1080p' });
    expect(setE).toHaveBeenCalledWith({ resolution: '1080p' });
    board.dispose();
    for (const call of [
      () => board.video.setPaused(true),
      () => board.video.setOptions({}),
      () => board.embeds.setOptions({}),
      () => board.interaction!.setOptions({}),
      () => board.camera.setRange(0.1, 2),
    ]) {
      expect(call).toThrow(expect.objectContaining({ code: 'disposed' }));
    }
  });

  it('interaction.setOptions reaches the interaction layer', async () => {
    const board = await make();
    const it_ = getInternals(board).interaction!;
    const spy = vi.spyOn(it_, 'setOptions');
    board.interaction!.setOptions({ marquee: false });
    expect(spy).toHaveBeenCalledWith({ marquee: false });
    board.dispose();
  });

  it('snapping returns a copy', async () => {
    const board = await make({ interaction: false });
    const s = board.snapping as { guides: boolean; grid: boolean };
    s.guides = !s.guides;
    expect(board.snapping.guides).toBe(true);
    board.setSnapping({ grid: true });
    expect(board.snapping).toEqual({ guides: true, grid: true });
    expect(board.snapping).not.toBe(board.snapping);
    board.dispose();
  });
});

describe('nullability: a lookup miss is undefined, "currently none" is null', () => {
  it('screenRect, embeds.info and bounds return undefined for a miss', async () => {
    const board = await make({ interaction: false });
    expect(board.screenRect('ghost')).toBeUndefined();
    expect(board.embeds.info('ghost')).toBeUndefined();
    expect(board.bounds()).toBeUndefined();
    expect(board.bounds(['ghost'])).toBeUndefined();
    expect(board.get('ghost')).toBeUndefined();
    // "none right now" stays null.
    expect(board.embeds.interacting).toBeNull();
    board.add(card('a', 5));
    expect(board.screenRect('a')).toEqual({ x: 20, y: 20, w: 200, h: 160 });
    h.stage!.boundsOf.mockReturnValueOnce({ x0: 1, y0: 2, x1: 3, y1: 4 } as never);
    expect(board.bounds(['a'])).toEqual({ x0: 1, y0: 2, x1: 3, y1: 4 });
    expect(h.stage!.boundsOf).toHaveBeenLastCalledWith(['a']);
    board.dispose();
  });

  it('camera.fit does nothing for an empty board and for ids that are no cards', async () => {
    const board = await make({ interaction: false });
    board.camera.fit();
    board.camera.fit(['ghost']);
    expect(h.stage!.fitRect).not.toHaveBeenCalled();
    board.add(card('a'));
    board.camera.fit(['a']);
    expect(h.stage!.fitRect).toHaveBeenCalledTimes(1);
    board.dispose();
  });
});

describe('camera validation', () => {
  it('set throws invalid for a non-finite tx / ty or a scale that is not > 0, and moves nothing', async () => {
    const board = await make({ interaction: false });
    for (const c of [
      { tx: NaN, ty: 0, scale: 1 },
      { tx: 0, ty: Infinity, scale: 1 },
      { tx: 0, ty: 0, scale: 0 },
      { tx: 0, ty: 0, scale: -2 },
      { tx: 0, ty: 0, scale: NaN },
      { tx: 0, ty: 0 },
      null,
    ]) {
      expect(() => board.camera.set(c as never), JSON.stringify(c)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
    expect(h.stage!.setCamera).not.toHaveBeenCalled();
    board.camera.set({ tx: 1, ty: 2, scale: 3 });
    expect(h.stage!.setCamera).toHaveBeenCalledWith({ tx: 1, ty: 2, scale: 3 });
    board.dispose();
  });

  it('setRange needs 0 < min <= max, finite, else throws invalid', async () => {
    const board = await make({ interaction: false });
    for (const [min, max] of [[0, 1], [-1, 1], [2, 1], [NaN, 1], [1, Infinity], [1, NaN]]) {
      expect(() => board.camera.setRange(min, max), `${min},${max}`).toThrow(CorkboardError);
    }
    expect(h.stage!.setScaleRange).not.toHaveBeenCalled();
    board.camera.setRange(0.1, 10);
    board.camera.setRange(1, 1);
    expect(h.stage!.setScaleRange).toHaveBeenNthCalledWith(1, 0.1, 10);
    board.dispose();
  });
});
