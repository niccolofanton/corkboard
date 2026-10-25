// @vitest-environment jsdom
// `invertChange` and `board.applyChange`: the contract (validation, the four steps, conflicts, sources), the
// anchors of `order`, and fuzz over random operation sequences: undo every change and get the initial board
// back (draw order included), redo them and get the final one, and keep two boards in sync through JSON.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/render/stage', () => ({
  GRID: 24,
  Stage: {
    async create() {
      return {
        cam: {
          cam: { tx: 0, ty: 0, scale: 1 },
          scale: 1,
          width: 1280,
          height: 800,
          isEmpty: false,
          visibleRect: () => ({ x0: 0, y0: 0, x1: 1280, y1: 800 }),
        },
        attach: () => {},
        dispose: () => {},
        onFrame: () => () => {},
        onSettle: () => () => {},
        requestFrame: () => {},
        overlay: { setSelection: () => {}, setHover: () => {}, setGuides: () => {}, setMarquee: () => {} },
        previewRectOf: () => undefined,
        activeTheme: () => 'dark',
        markDirty: () => {},
        fitRect: vi.fn(),
        boundsOf: vi.fn(() => undefined),
        setCamera: vi.fn(),
        setScaleRange: vi.fn(),
        worldToScreen: (x: number, y: number) => ({ x, y }),
        clearPreview: () => {},
        pin: () => {},
        stats: () => ({ cards: 0, mounted: 0 }),
      };
    },
  },
}));

import { Corkboard } from '../src/Corkboard';
import { invertChange } from '../src/change';
import { CorkboardError } from '../src/errors';
import type { BoardSnapshot } from '../src/snapshot';
import type { Change, Card, CardInit } from '../src/types';

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

const make = () => Corkboard.create(host, { interaction: false });
const card = (id: string, x = 0): CardInit & { id: string } => ({ id, x, y: 0, w: 100, h: 80, media: { src: `${id}.jpg` } });
const order = (b: Corkboard) => b.all().map((e) => e.id);
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const snap = (b: Corkboard) => json(b.getSnapshot({ camera: false }));

function record(board: Corkboard) {
  const events: Change[] = [];
  board.on('change', (c) => events.push(c));
  return events;
}

describe('invertChange', () => {
  it('swaps added / removed, el / prev and the anchors; it is pure and an involution', async () => {
    const board = await make();
    board.add([card('a'), card('b', 100), card('c', 200)]);
    const events = record(board);
    board.batch(() => {
      board.remove('b');
      board.update('c', { x: 5, data: { n: 1 } });
      board.add(card('n', 300));
      board.bringToFront('a');
    });
    const c = events[0];
    const copy = json(c);
    const inv = invertChange(c);
    expect(json(c)).toEqual(copy);
    expect(inv.added).toEqual(c.removed);
    expect(inv.removed).toEqual(c.added);
    expect(inv.updated[0].el).toBe(c.updated[0].prev);
    expect(inv.updated[0].prev).toBe(c.updated[0].el);
    expect(inv.updated[0].props).toEqual(c.updated[0].props);
    expect(inv.source).toBe(c.source);
    expect(inv.order!.moved.map((m) => [m.id, m.prevBelow, m.nextBelow])).toEqual(
      c.order!.moved.map((m) => [m.id, m.nextBelow, m.prevBelow]),
    );
    expect(invertChange(inv)).toEqual(c);
    board.dispose();
  });

  it('a change without order stays without', () => {
    const c: Change = { source: 'api', added: [], removed: [], updated: [] };
    expect('order' in invertChange(c)).toBe(false);
  });
});

describe('order anchors', () => {
  it('a pure append has no entry; the cards of a bringToFront / sendToBack are the given ids', async () => {
    const board = await make();
    const events = record(board);
    board.add([card('a'), card('b'), card('c'), card('d')]);
    board.bringToFront(['a', 'c']);
    board.sendToBack(['d']);
    expect(events[0].order).toBeUndefined();
    expect(events[1].order).toEqual({
      moved: [
        { id: 'a', prevBelow: null, nextBelow: 'd' },
        { id: 'c', prevBelow: 'b', nextBelow: 'a' },
      ],
    });
    expect(events[2].order).toEqual({ moved: [{ id: 'd', prevBelow: 'b', nextBelow: null }] });
    board.dispose();
  });

  it('a delete carries the card with its prevBelow; a multi-delete chains, and undo restores the depth', async () => {
    const board = await make();
    board.add([card('a'), card('b'), card('c'), card('d')]);
    const events = record(board);
    board.remove(['b', 'c']);
    expect(events[0].order).toEqual({
      moved: [
        { id: 'b', prevBelow: 'a', nextBelow: null },
        { id: 'c', prevBelow: 'b', nextBelow: null },
      ],
    });
    board.applyChange(events[0], { invert: true });
    expect(order(board)).toEqual(['a', 'b', 'c', 'd']);
    board.dispose();
  });

  it('an added card that is not on top gets an entry; redoing a pure append lands on top', async () => {
    const board = await make();
    board.add([card('a'), card('b')]);
    const events = record(board);
    board.batch(() => {
      board.add(card('n'));
      board.sendToBack('n');
    });
    expect(events[0].order).toEqual({ moved: [{ id: 'n', prevBelow: null, nextBelow: null }] });
    board.applyChange(events[0], { invert: true });
    expect(order(board)).toEqual(['a', 'b']);
    board.applyChange(events[0]);
    expect(order(board)).toEqual(['n', 'a', 'b']);
    board.dispose();
  });

  it('is minimal for setOrder: the longest run that kept its relative order stays out of `moved`', async () => {
    const board = await make();
    board.add(['a', 'b', 'c', 'd', 'e'].map((i) => card(i)));
    const events = record(board);
    board.setOrder(['a', 'c', 'b', 'd', 'e']);
    expect(events[0].order!.moved).toHaveLength(1);
    board.dispose();
  });

  it('loadSnapshot carries its order too, so undoing a load restores the depth', async () => {
    const board = await make();
    board.add([card('a'), card('b', 100), card('c', 200)]);
    const before = snap(board);
    const events = record(board);
    board.loadSnapshot({
      format: 'corkboard',
      version: 1,
      elements: [
        { id: 'c', x: 200, y: 0, w: 100, h: 80, media: { src: 'c.jpg' } },
        { id: 'z', x: 0, y: 0, w: 10, h: 10, media: { src: 'z.jpg' } },
        { id: 'a', x: 0, y: 0, w: 100, h: 80, media: { src: 'a.jpg' } },
      ],
    });
    expect(order(board)).toEqual(['c', 'z', 'a']);
    expect(events[0].source).toBe('load');
    expect(events[0].order).toBeDefined();
    board.applyChange(events[0], { invert: true });
    expect(snap(board)).toEqual(before);
    board.dispose();
  });
});

describe('applyChange', () => {
  it('defaults: source apply / undo, one event, and the result of a round trip', async () => {
    const board = await make();
    board.add([card('a'), card('b', 100)]);
    const events = record(board);
    board.update('a', { x: 40 });
    const c = events[0];
    board.applyChange(c, { invert: true });
    board.applyChange(c);
    board.applyChange(c, { invert: true, source: 'history' });
    expect(events.map((e) => e.source)).toEqual(['api', 'undo', 'apply', 'history']);
    expect(events).toHaveLength(4);
    expect(board.get('a')?.x).toBe(0);
    board.dispose();
  });

  it('validates first: a bad value throws invalid and nothing changes', async () => {
    const board = await make();
    board.add([card('a'), card('b', 100)]);
    const before = snap(board);
    const events = record(board);
    const good = { ...board.get('a')!, id: 'n' };
    const bads: unknown[] = [
      null,
      { source: 'x', added: [], removed: [], updated: 3 },
      { source: 'x', added: [{ ...good, w: -1 }], removed: [], updated: [] },
      { source: 'x', added: [{ ...good, kind: 'nope' }], removed: [], updated: [] },
      { source: 'x', added: [{ ...good, media: { embed: { url: 'u', html: 'h' } } }], removed: [], updated: [] },
      { source: 'x', added: [good], removed: [{ id: 5 }], updated: [] },
      { source: 'x', added: [good], removed: [], updated: [{ el: { ...good, id: 'a', x: NaN }, prev: good, props: ['x'] }] },
      { source: 'x', added: [good], removed: [], updated: [{ el: good, prev: good, props: ['id'] }] },
      { source: 'x', added: [good], removed: [], updated: [], order: { moved: [{ id: 'a', prevBelow: 1, nextBelow: null }] } },
      { source: 'x', added: [good], removed: [], updated: [], order: { moved: 'a' } },
    ];
    for (const bad of bads) {
      expect(() => board.applyChange(bad as Change), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
    expect(snap(board)).toEqual(before);
    expect(events).toEqual([]);
    board.dispose();
    expect(() => board.applyChange({ source: 'x', added: [], removed: [], updated: [] })).toThrow(
      expect.objectContaining({ code: 'disposed' }),
    );
  });

  it('removes (missing ids skipped), upserts exactly as given (no placement, no default size), overwrites an existing id', async () => {
    const board = await make();
    board.add([card('a'), card('b', 100)]);
    const exact = { id: 'n', kind: 'image', x: 7, y: 9, w: 33, h: 44, rot: 12, locked: true, media: { src: 'n.jpg', aspect: 3 }, radius: 2, aspectLocked: false } as const;
    board.applyChange({
      source: 'x',
      removed: [{ ...board.get('a')!, id: 'ghost' }, board.get('b')!],
      added: [exact, { ...exact, id: 'a', x: 1, data: { k: 1 } }],
      updated: [],
    });
    expect(order(board)).toEqual(['a', 'n']);
    expect(board.get('n')).toEqual(exact);
    expect(board.get('a')).toMatchObject({ x: 1, w: 33, h: 44, data: { k: 1 } });
    board.dispose();
  });

  it('writes updated fields raw: h is not derived from the media aspect, an undefined field clears data', async () => {
    const board = await make();
    board.add({ ...card('a'), data: { k: 1 } });
    const events = record(board);
    board.update('a', { media: { src: 'a.jpg', aspect: 2 }, data: undefined });
    const c = json(events[0]);
    expect(board.get('a')).toMatchObject({ h: 200, w: 100 });
    expect(c.updated[0].props).toEqual(['h', 'media', 'data']);
    board.applyChange(c, { invert: true });
    expect(board.get('a')).toMatchObject({ h: 80, data: { k: 1 } });
    // Forward again, from the JSON copy: `data` is missing from `el`, and that clears it.
    board.applyChange(c);
    expect(board.get('a')).toMatchObject({ h: 200 });
    expect(board.get('a')!.data).toBeUndefined();
    board.dispose();
  });

  it('a card that is gone is a no-op; conflicts: skip leaves an edited field, overwrite writes it', async () => {
    const board = await make();
    board.add([card('a'), card('b', 100)]);
    const events = record(board);
    board.update('a', { x: 10, y: 20 });
    board.update('b', { x: 99 });
    const [ca, cb] = events;
    board.update('a', { x: 50 });
    board.remove('b');
    board.applyChange(ca, { invert: true });
    // x was edited since (10 -> 50): left alone; y still held the change's value: reverted.
    expect(board.get('a')).toMatchObject({ x: 50, y: 0 });
    board.applyChange(cb, { invert: true });
    board.applyChange(ca, { invert: true, conflict: 'overwrite' });
    expect(board.get('a')).toMatchObject({ x: 0, y: 0 });
    expect(board.get('b')).toBeUndefined();
    board.dispose();
  });

  it('skip compares structurally: media and data equal in value count as unchanged', async () => {
    const board = await make();
    board.add({ ...card('a'), data: { deep: { n: [1, 2] } } });
    const events = record(board);
    board.update('a', { media: { src: 'b.jpg' }, data: { deep: { n: [3] } } });
    // Somebody else wrote values equal to the change's: same value, different objects.
    board.update('a', { media: { src: 'b.jpg' }, data: json({ deep: { n: [3] } }) });
    board.applyChange(events[0], { invert: true });
    expect(board.get('a')!.media).toEqual({ src: 'a.jpg' });
    expect(board.get('a')!.data).toEqual({ deep: { n: [1, 2] } });
    board.dispose();
  });

  it('skips order entries whose card or anchor is missing; never half-fails', async () => {
    const board = await make();
    board.add([card('a'), card('b'), card('c')]);
    board.applyChange({
      source: 'x',
      added: [],
      removed: [],
      updated: [],
      order: {
        moved: [
          { id: 'ghost', prevBelow: null, nextBelow: 'a' },
          { id: 'a', prevBelow: null, nextBelow: 'ghost' },
          { id: 'c', prevBelow: 'b', nextBelow: null },
        ],
      },
    });
    expect(order(board)).toEqual(['c', 'a', 'b']);
    board.dispose();
  });

  it('does not touch the camera or the selection', async () => {
    const board = await make();
    board.add([card('a')]);
    const events = record(board);
    board.update('a', { x: 5 });
    board.applyChange(events[0], { invert: true });
    expect(events.map((e) => e.source)).toEqual(['api', 'undo']);
    board.dispose();
  });
});

describe('stored data is JSON-safe', () => {
  it('a Uint8Array thumbhash is stored as base64 by add, update and in the change payloads', async () => {
    const board = await make();
    const events = record(board);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    board.add({ ...card('a'), media: { src: 'a.jpg', thumbhash: bytes } });
    expect(board.get('a')!.media.thumbhash).toBe('AQIDBAU=');
    board.update('a', { media: { src: 'a.jpg', thumbhash: new Uint8Array([5, 4, 3, 2, 1]) } });
    expect(board.get('a')!.media.thumbhash).toBe('BQQDAgE=');
    expect(JSON.parse(JSON.stringify(events))).toEqual(JSON.parse(JSON.stringify(events.map((e) => ({ ...e })))));
    expect(events[1].updated[0].prev.media.thumbhash).toBe('AQIDBAU=');
    expect(typeof events[1].updated[0].el.media.thumbhash).toBe('string');
    board.dispose();
  });

  it('add copies media: later changes to the caller\'s object reach neither the card nor the history', async () => {
    const board = await make();
    const events = record(board);
    const media = { src: 'a.jpg', sizes: { small: 's.jpg' }, embed: { url: 'https://x.test/' } };
    board.add({ ...card('a'), media });
    media.src = 'changed';
    media.sizes.small = 'changed';
    media.embed.url = 'changed';
    expect(board.get('a')!.media).toEqual({ src: 'a.jpg', sizes: { small: 's.jpg' }, embed: { url: 'https://x.test/' } });
    expect(events[0].added[0].media.src).toBe('a.jpg');
    board.dispose();
  });
});

describe('loadSnapshot echo and hand-written snapshots', () => {
  it('loading the same JSON twice emits nothing, even with data (a new but equal object keeps the board\'s)', async () => {
    const board = await make();
    board.add([{ ...card('a'), data: { n: 1, list: [1, { z: 2 }] } }, { ...card('b', 100), data: 'text' }]);
    const text = JSON.stringify(board.getSnapshot());
    const events = record(board);
    board.loadSnapshot(JSON.parse(text) as BoardSnapshot);
    const data = board.get('a')!.data;
    board.loadSnapshot(JSON.parse(text) as BoardSnapshot);
    expect(events).toEqual([]);
    expect(board.get('a')!.data).toBe(data);
    board.dispose();
  });

  it('kind defaults from media; only id, x, y, w, h and media are required', async () => {
    const board = await make();
    board.loadSnapshot({
      format: 'corkboard',
      version: 1,
      elements: [
        { id: 'i', x: 0, y: 0, w: 10, h: 10, media: { src: 'i.jpg' } },
        { id: 'v', x: 0, y: 0, w: 10, h: 10, media: { src: 'v.jpg', video: 'v.mp4' } },
        { id: 'e', x: 0, y: 0, w: 10, h: 10, media: { embed: { url: 'https://x.test/' } } },
      ],
    });
    expect(board.all().map((e) => [e.id, e.kind])).toEqual([['i', 'image'], ['v', 'video'], ['e', 'embed']]);
    for (const missing of ['id', 'x', 'y', 'w', 'h', 'media']) {
      const el = { id: 'i', x: 0, y: 0, w: 10, h: 10, media: { src: 'i.jpg' } } as Record<string, unknown>;
      delete el[missing];
      expect(() => board.loadSnapshot({ format: 'corkboard', version: 1, elements: [el as never] }), missing).toThrow(
        expect.objectContaining({ code: 'invalid' }),
      );
    }
    board.dispose();
  });
});

// ── Fuzz ─────────────────────────────────────────────────────────────────────
function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T,>(l: readonly T[]): T => l[int(l.length)];
  const shuffle = <T,>(l: readonly T[]): T[] => {
    const o = [...l];
    for (let i = o.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [o[i], o[j]] = [o[j], o[i]];
    }
    return o;
  };
  const subset = <T,>(l: readonly T[], max = 4): T[] => shuffle(l).slice(0, 1 + int(Math.min(max, l.length)));
  return { next, int, pick, shuffle, subset };
}

type R = ReturnType<typeof rng>;

// Layout calls with good options (any ids, one id or a list), and with bad ones: a bad call throws 'invalid' and
// leaves the board exactly as it was; the board always round-trips through its own snapshot afterwards.
function randomLayout(board: Corkboard, r: R, ids: readonly string[]): void {
  const L = board.layout;
  const target = r.pick([undefined, r.subset(ids), r.pick(ids)]);
  const arrange = { animate: false, ...(r.next() < 0.3 ? { duration: r.int(500) } : {}) };
  const grid = {
    ...arrange,
    ...(r.next() < 0.5 ? { gap: r.int(80) } : {}),
    ...(r.next() < 0.4 ? { columns: 1 + r.int(6) } : {}),
  };
  if (r.next() < 0.35) {
    const before = snap(board);
    const bad: (() => void)[] = [
      () => L.tidy(target, { gap: NaN, animate: false }),
      () => L.tidy(target, { gap: -5, animate: false }),
      () => L.tidy(target, { gap: Infinity, animate: false }),
      () => L.tidy(target, { columns: 0, animate: false }),
      () => L.tidy(target, { columns: 2.5, animate: false }),
      () => L.tidy(target, { columns: NaN, animate: false }),
      () => L.tidy(target, { animate: false, duration: NaN }),
      () => L.masonry(target, { width: -50, animate: false }),
      () => L.masonry(target, { width: NaN, animate: false }),
      () => L.masonry(target, { width: 0, animate: false }),
      () => L.masonry(target, { gap: NaN, animate: false }),
      () => L.align('diagonal' as never, target, { animate: false }),
      () => L.distribute('z' as never, target, { animate: false }),
      () => L.equalWidth(target, { duration: -1, animate: false }),
      () => L.equalWidth(target, { animate: 'no' as never }),
      () => L.tidy(5 as never, { animate: false }),
      () => L.masonry(null as never, { animate: false }),
      () => L.align('left', [1] as never, { animate: false }),
      () => L.distribute('x', {} as never, { animate: false }),
      () => L.tidy(target, null as never),
    ];
    expect(bad[r.int(bad.length)]).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(snap(board)).toEqual(before);
    return;
  }
  switch (r.int(5)) {
    case 0:
      L.tidy(target, grid);
      break;
    case 1:
      L.masonry(target, { ...grid, ...(r.next() < 0.4 ? { width: 60 + r.int(300) } : {}) });
      break;
    case 2:
      L.align(r.pick(['left', 'centerX', 'right', 'top', 'middleY', 'bottom'] as const), target, arrange);
      break;
    case 3:
      L.distribute(r.pick(['x', 'y'] as const), target, arrange);
      break;
    default:
      L.equalWidth(target, arrange);
  }
  // Whatever the layout wrote is a card the board can load back (finite position, size > 0).
  const snapshot = json(board.getSnapshot({ camera: false }));
  expect(() => board.loadSnapshot(snapshot, { camera: false })).not.toThrow();
}

// One random operation on a board: every kind of write the library has.
function randomOp(board: Corkboard, r: R, serial: { n: number }, saved: BoardSnapshot[]): void {
  const ids = order(board);
  const some = ids.length > 0;
  const media = (): CardInit['media'] =>
    r.pick<CardInit['media']>([
      { src: `m${serial.n++}.jpg` },
      { src: `m${serial.n++}.jpg`, aspect: 0.4 + r.int(20) / 10 },
      { src: `m${serial.n++}.jpg`, thumbhash: new Uint8Array([r.int(256), r.int(256), r.int(256), r.int(256), r.int(256)]) },
      { src: `m${serial.n++}.jpg`, video: 'v.mp4' },
      { embed: { url: `https://x.test/${serial.n++}` } },
    ]);
  const fresh = (): CardInit & { id: string } => ({
    id: `c${serial.n++}`,
    ...(r.next() < 0.7 ? { x: r.int(2000), y: r.int(2000) } : {}),
    ...(r.next() < 0.5 ? { w: 40 + r.int(300) } : {}),
    ...(r.next() < 0.2 ? { data: { v: r.int(9), list: [r.int(3)] } } : {}),
    media: media(),
  });
  const op = r.int(14);
  if (op <= 2 || !some) {
    board.add(Array.from({ length: 1 + r.int(3) }, fresh));
    return;
  }
  const id = r.pick(ids);
  switch (op) {
    case 3:
      board.update(id, { x: r.int(3000), y: r.int(3000) });
      return;
    case 4:
      board.update(id, { media: media() });
      return;
    case 5:
      board.update(id, r.pick([{ data: { v: r.int(9) } }, { data: undefined }, { data: null }, { locked: r.next() < 0.5 }, { radius: r.int(20) }]));
      return;
    case 6:
      board.remove(id);
      return;
    case 7:
      board.remove(r.subset(ids, 5));
      return;
    case 8:
      board.bringToFront(r.subset(ids));
      return;
    case 9:
      board.sendToBack(r.subset(ids));
      return;
    case 10:
      board.setOrder(r.shuffle(ids));
      return;
    case 11:
      randomLayout(board, r, ids);
      return;
    case 12: {
      // loadSnapshot: an earlier state of the board, or the current one with a reorder and a nudge.
      const s = saved.length > 0 && r.next() < 0.5 ? r.pick(saved) : board.getSnapshot({ camera: false });
      const copy = json(s);
      if (r.next() < 0.5) copy.elements = r.shuffle(copy.elements);
      if (r.next() < 0.5 && copy.elements.length > 0) copy.elements[0].x += 7;
      board.loadSnapshot(copy);
      return;
    }
    default:
      // A batch of several writes: one event, the net diff.
      board.batch(() => {
        board.add(fresh());
        board.update(id, { x: r.int(500) });
        board.bringToFront(r.subset(order(board)));
        if (r.next() < 0.5) board.remove(r.pick(order(board)));
        if (r.next() < 0.3) board.sendToBack(r.subset(order(board)));
      });
  }
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7];

describe('fuzz: undo / redo', () => {
  it.each(SEEDS)('seed %i: undoing every change restores each earlier state (order included); redoing restores the final one', async (seed) => {
    const r = rng(seed);
    const board = await make();
    const serial = { n: 0 };
    const saved: BoardSnapshot[] = [];
    // Start with a few cards, so the first changes are not all appends to an empty board.
    board.add(Array.from({ length: 3 }, (_, i) => card(`s${i}`, i * 150)));
    const initial = snap(board);
    const history: { change: Change; pre: BoardSnapshot; post: BoardSnapshot }[] = [];
    let pending: Change[] = [];
    board.on('change', (c) => {
      if (!['system', 'undo', 'apply'].includes(c.source)) pending.push(c);
    });
    for (let i = 0; i < 300; i++) {
      const pre = snap(board);
      pending = [];
      randomOp(board, r, serial, saved);
      expect(pending.length, `op ${i}`).toBeLessThanOrEqual(1);
      if (pending.length === 1) history.push({ change: json(pending[0]), pre, post: snap(board) });
      if (i % 25 === 0) saved.push(board.getSnapshot({ camera: false }));
    }
    expect(history.length).toBeGreaterThan(150);
    const final = snap(board);
    for (let i = history.length - 1; i >= 0; i--) {
      board.applyChange(history[i].change, { invert: true });
      expect(snap(board), `undo of change ${i}`).toEqual(history[i].pre);
    }
    expect(snap(board)).toEqual(initial);
    for (let i = 0; i < history.length; i++) {
      board.applyChange(history[i].change);
      expect(snap(board), `redo of change ${i}`).toEqual(history[i].post);
    }
    expect(snap(board)).toEqual(final);
    board.dispose();
  });
});

describe('fuzz: two boards in sync through JSON', () => {
  it.each(SEEDS)('seed %i: 500 operations on one, replayed on the other, keep the snapshots equal', async (seed) => {
    const r = rng(seed * 101);
    const a = await make();
    const b = await make();
    const serial = { n: 0 };
    const saved: BoardSnapshot[] = [];
    a.add(Array.from({ length: 4 }, (_, i) => card(`s${i}`, i * 150)));
    b.loadSnapshot(json(a.getSnapshot()));
    expect(snap(b)).toEqual(snap(a));
    let wire: string[] = [];
    a.on('change', (c) => {
      if (!['system', 'undo', 'apply'].includes(c.source)) wire.push(JSON.stringify(c));
    });
    let sent = 0;
    for (let i = 0; i < 500; i++) {
      wire = [];
      randomOp(a, r, serial, saved);
      for (const m of wire) {
        b.applyChange(JSON.parse(m) as Change);
        sent++;
      }
      expect(snap(b), `op ${i}`).toEqual(snap(a));
      if (i % 40 === 0) saved.push(a.getSnapshot({ camera: false }));
    }
    expect(sent).toBeGreaterThan(300);
    a.dispose();
    b.dispose();
  });
});

describe('applyChange: a change that is not a net diff or not valid is refused whole', () => {
  const invalid = (fn: () => void, match: RegExp) => {
    let err: unknown;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CorkboardError);
    expect((err as CorkboardError).code).toBe('invalid');
    expect((err as CorkboardError).message).toMatch(match);
  };

  async function setup() {
    const b = await make();
    b.add([card('a'), card('b'), card('c', 200)]);
    const events = record(b);
    return { b, events, before: snap(b), ids: order(b) };
  }
  const base = { source: 'api' as const, added: [], removed: [], updated: [] };

  it('duplicate ids in added: nothing is removed, nothing is emitted', async () => {
    const { b, events, before, ids } = await setup();
    const n = { ...b.get('a'), id: 'n' } as never;
    invalid(() => b.applyChange({ ...base, added: [n, n], removed: [b.get('b') as never] }), /duplicate id "n"/);
    expect(order(b)).toEqual(ids);
    expect(snap(b)).toEqual(before);
    expect(events).toHaveLength(0);
  });

  it('duplicate ids in removed, an id both added and removed, an id twice in updated', async () => {
    const { b, events, before } = await setup();
    const a = b.get('a') as Card;
    invalid(() => b.applyChange({ ...base, removed: [a, a] }), /duplicate id "a"/);
    const n = { ...(b.get('a') as object), id: 'n' } as never;
    invalid(() => b.applyChange({ ...base, added: [n], removed: [n] }), /both added and removed/);
    const u = { el: { ...(b.get('a') as object), x: 5 } as never, prev: a, props: ['x' as const] };
    invalid(() => b.applyChange({ ...base, updated: [u, u] }), /duplicate id "a"/);
    expect(snap(b)).toEqual(before);
    expect(events).toHaveLength(0);
  });

  it('the same rules hold inverted', async () => {
    const { b, events, before } = await setup();
    const n = { ...(b.get('a') as object), id: 'n' } as never;
    invalid(() => b.applyChange({ ...base, removed: [n, n] }, { invert: true }), /duplicate id "n"/);
    invalid(() => b.applyChange({ ...base, added: [b.get('a') as never, b.get('a') as never] }, { invert: true }), /duplicate id "a"/);
    expect(snap(b)).toEqual(before);
    expect(events).toHaveLength(0);
  });

  it('inverted: a removed entry is written back whole, so it is checked whole', async () => {
    const { b, events, before } = await setup();
    // `{ id }` alone passes as a removal; inverted it would be an upsert of a card with no fields.
    invalid(() => b.applyChange({ ...base, added: [b.get('a') as never], removed: [{ id: 'z' } as never] }, { invert: true }), /removed\[0\]/);
    invalid(() => b.applyChange({ ...base, removed: [{ ...b.get('a'), w: -1 } as never] }, { invert: true }), /w must be/);
    expect(snap(b)).toEqual(before);
    expect(events).toHaveLength(0);
    // The same entry is fine as a plain removal.
    b.applyChange({ ...base, removed: [{ id: 'z' } as never, b.get('b') as never] });
    expect(order(b)).toEqual(['a', 'c']);
  });

  it('inverted: the prev values that would be written are checked, not the el ones', async () => {
    const { b, events, before } = await setup();
    const a = b.get('a') as Card;
    const u = (prev: object) => ({ el: a, prev: prev as never, props: ['x' as const, 'w' as const] });
    invalid(() => b.applyChange({ ...base, updated: [u({ ...a, x: NaN })] }, { invert: true }), /x must be a finite/);
    invalid(() => b.applyChange({ ...base, updated: [u({ ...a, w: -5 })] }, { invert: true }), /w must be/);
    invalid(() => b.applyChange({ ...base, updated: [u({ id: 'a' })] }, { invert: true }), /is missing/);
    invalid(
      () => b.applyChange({ ...base, updated: [{ el: a, prev: { ...a, media: 3 } as never, props: ['media'] }] }, { invert: true }),
      /media must be an object/,
    );
    expect(snap(b)).toEqual(before);
    expect(events).toHaveLength(0);
    // Not inverted, the el values are the ones that count: the same change applies.
    b.applyChange({ ...base, updated: [{ el: { ...a, x: 7 } as never, prev: { ...a, x: NaN } as never, props: ['x'] }] });
    expect(b.get('a')?.x).toBe(7);
  });

  it('a malformed shape is an invalid error whatever the direction, never a TypeError', async () => {
    const { b, events, before } = await setup();
    const a = b.get('a') as Card;
    const shapes: Partial<Change>[] = [
      { added: [null as never] },
      { removed: [null as never] },
      { removed: [7 as never] },
      { updated: [null as never] },
      { updated: [{ el: a, prev: null as never, props: [] }] },
      { updated: [{ el: null as never, prev: a, props: [] }] },
      { updated: [{ el: a, prev: a, props: 'x' as never }] },
      { order: { moved: [null as never] } },
    ];
    for (const s of shapes) {
      for (const invert of [false, true]) {
        invalid(() => b.applyChange({ ...base, ...s }, { invert }), /applyChange/);
      }
    }
    expect(snap(b)).toEqual(before);
    expect(events).toHaveLength(0);
  });
});
