// TextureManager's worker bookkeeping against stub workers (no GL: the renderer is a stub, nothing is
// uploaded).
// Pixi probes a 2D canvas on import; jsdom has none and would print a not-implemented error.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absoluteUrl, TextureManager, type WantedItem } from '../../src/render/textures';
import type { BoardCard } from '../../src/render/types';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: Array<{ op: string; rid: number }> = [];
  args: unknown[];
  constructor(...args: unknown[]) {
    this.args = args;
    FakeWorker.all.push(this);
  }
  postMessage(m: { op: string; rid: number }): void {
    this.sent.push(m);
  }
  terminate(): void {}
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const card = (id: number): BoardCard => ({
  id,
  w: 100,
  h: 100,
  thumbhash: undefined,
  l1Url: `https://x.test/${id}.jpg`,
  l2Url: undefined,
  l3Url: undefined,
  radius: 4,
});
const want = (...ids: number[]): WantedItem[] => ids.map((id) => ({ card: card(id), level: 1, dist: id }));

let tm: TextureManager;
beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  tm = new TextureManager({ texture: {}, gl: {} } as never, { budgetBytes: 1 << 30, workers: 1, onWake: () => {} });
});
afterEach(() => {
  tm.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const load = () => (tm as unknown as { workerLoad: number[] }).workerLoad;

describe('TextureManager worker load', () => {
  it("sends the card's height / width so the worker can crop to its shape", () => {
    tm.setWanted([{ card: { ...card(1), w: 400, h: 100 }, level: 1, dist: 0 }]);
    const m = FakeWorker.all[0].sent[0] as unknown as { aspect?: number };
    expect(m.aspect).toBeCloseTo(0.25);
  });

  it('counts a request in and out', () => {
    tm.setWanted(want(1, 2));
    expect(load()).toEqual([2]);
    const [w] = FakeWorker.all;
    w.reply({ op: 'fail', rid: w.sent[0].rid, reason: 'x', aborted: false });
    expect(load()).toEqual([1]);
  });

  it('does not let replies to pre-reset requests eat into the new requests\' count', () => {
    tm.setWanted(want(1, 2));
    const [w] = FakeWorker.all;
    const stale = w.sent.map((m) => m.rid);
    tm.reset();
    expect(load()).toEqual([0]);
    tm.setWanted(want(3));
    expect(load()).toEqual([1]);
    // The workers answer the cancels sent by reset().
    for (const rid of stale) w.reply({ op: 'fail', rid, reason: 'aborted', aborted: true });
    expect(load()).toEqual([1]);
    // ... and the live one still balances to zero.
    const live = w.sent.filter((m) => m.op === 'load' && !stale.includes(m.rid))[0];
    w.reply({ op: 'fail', rid: live.rid, reason: 'x', aborted: false });
    expect(load()).toEqual([0]);
  });
});

describe('TextureManager worker source', () => {
  it('starts the built-in worker by default, and a module worker at textures.workerUrl when given', () => {
    // `tm` (beforeEach) has no workerUrl: the built-in wrapper made it.
    expect(FakeWorker.all).toHaveLength(1);
    expect(String(FakeWorker.all[0].args[0])).not.toContain('cdn.test');
    FakeWorker.all = [];
    const custom = new TextureManager({ texture: {}, gl: {} } as never, {
      budgetBytes: 1,
      workers: 2,
      workerUrl: 'https://cdn.test/decode.worker.js',
      onWake: () => {},
    });
    expect(FakeWorker.all.map((w) => w.args)).toEqual([
      ['https://cdn.test/decode.worker.js', { type: 'module' }],
      ['https://cdn.test/decode.worker.js', { type: 'module' }],
    ]);
    custom.dispose();
  });
});

describe('absoluteUrl', () => {
  it('resolves relative URLs against the page (the worker has a blob: base), and leaves absolute ones alone', () => {
    const base = document.baseURI;
    expect(absoluteUrl('/img/a.jpg')).toBe(new URL('/img/a.jpg', base).href);
    expect(absoluteUrl('a.jpg')).toBe(new URL('a.jpg', base).href);
    expect(absoluteUrl('https://x.test/a.jpg?q=1')).toBe('https://x.test/a.jpg?q=1');
    expect(absoluteUrl('blob:http://x.test/uuid')).toBe('blob:http://x.test/uuid');
    expect(absoluteUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(absoluteUrl(undefined)).toBeUndefined();
  });

  it('is what the worker is sent', () => {
    const rel = { ...card(7), l1Url: 'img/rel.jpg' };
    tm.setWanted([{ card: rel, level: 1, dist: 0 }]);
    const sent = FakeWorker.all[0].sent[0] as unknown as { url: string };
    expect(sent.url).toBe(new URL('img/rel.jpg', document.baseURI).href);
  });
});

// Uploads against a recording GL stub (no real GPU: only the calls are checked).
describe('TextureManager decode / upload', () => {
  const RGBA = 6408;
  const UBYTE = 5121;
  type Call = [number, number, number, number, number, number, number, number, unknown];
  let calls: unknown[][];
  // The manager under test replaces the suite's stub one (its afterEach disposes it).
  let um: TextureManager;
  const bitmap = (w: number, h: number) => ({ width: w, height: h, close: () => {} });
  const done = (w: FakeWorker, rid: number, bw: number, bh: number) =>
    w.reply({ op: 'done', rid, bitmap: bitmap(bw, bh), w: bw, h: bh, fetched: 1, decodeMs: 1 });
  const loads = (w: FakeWorker) => w.sent.filter((m) => m.op === 'load');
  // Decodes and uploads one level-1 request of `id` (the nth load sent), at the given bitmap size.
  const land = (id: number, bw: number, bh: number) => {
    um.setWanted([{ card: card(id), level: 1, dist: 0 }, ...resident]);
    const w = FakeWorker.all[0];
    done(w, loads(w).at(-1)!.rid, bw, bh);
    um.frame(1000, 0);
  };
  let resident: WantedItem[];

  beforeEach(() => {
    calls = [];
    resident = [];
    const gl = {
      RGBA,
      UNSIGNED_BYTE: UBYTE,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441,
      bindTexture: () => {},
      pixelStorei: () => {},
      generateMipmap: () => {},
      texSubImage2D: (...a: unknown[]) => calls.push(a),
    };
    const texSys = {
      getGlSource: () => ({ target: 3553, texture: {} }),
      initSource: () => {},
      _activateLocation: () => {},
      _setBoundTexture: () => {},
      _premultiplyAlpha: true,
    };
    tm.dispose();
    FakeWorker.all = [];
    um = tm = new TextureManager({ texture: texSys, gl } as never, {
      budgetBytes: 1 << 30,
      workers: 1,
      onWake: () => {},
    });
  });

  it('does not request a level again while its decoded bitmap waits for the upload', () => {
    um.setWanted(want(1));
    const [w] = FakeWorker.all;
    done(w, loads(w)[0].rid, 100, 80);
    expect(um.pendingWork).toBe(true);
    expect(um.queued).toBe(0);
    expect(um.inflightCount).toBe(0);
    // The stage's LOD pass runs before the upload step in a tick, so it asks for the level once more.
    um.setWanted(want(1));
    expect(loads(w)).toHaveLength(1);
    expect(um.queued).toBe(0);
    expect(um.inflightCount).toBe(0);
    // Uploaded: resident, still asked for nothing.
    um.frame(1000, 0);
    expect(um.has(card(1), 1)).toBe(true);
    um.setWanted(want(1));
    expect(loads(w)).toHaveLength(1);
  });

  it('asks again once reset() or forget() dropped the waiting bitmap', () => {
    um.setWanted(want(1, 2));
    const [w] = FakeWorker.all;
    done(w, loads(w)[0].rid, 100, 80);
    done(w, loads(w)[1].rid, 100, 80);
    um.forget(1);
    um.setWanted(want(1, 2));
    // Card 1's bitmap is gone, so it is wanted again; card 2's still waits.
    expect(loads(w).map((m) => m.rid)).toHaveLength(3);
    um.reset();
    um.setWanted(want(2));
    expect(loads(w)).toHaveLength(4);
  });

  it('clears the rest of a recycled atlas cell that a smaller bitmap does not cover', () => {
    // Card 9 keeps the page alive; card 1 takes cell 0 with a full 128 x 128 bitmap, then goes away.
    resident = want(9);
    land(9, 128, 128);
    land(1, 128, 128);
    // Two full-size bitmaps in fresh cells: nothing to blank.
    expect(calls).toHaveLength(2);
    um.forget(1);
    um.afterRender();
    um.afterRender();
    calls.length = 0;
    // Card 2 reuses card 1's cell with a 128 x 96 bitmap: the 32 rows under it are blanked first.
    land(2, 128, 96);
    const cell = (calls.at(-1) as Call).slice(2, 4) as [number, number];
    const clear = calls.slice(0, -1) as Call[];
    expect(clear).toHaveLength(1);
    expect(clear[0].slice(2, 6)).toEqual([cell[0], cell[1] + 96, 128, 32]);
    const zeros = clear[0][8] as Uint8Array;
    expect(zeros.length).toBeGreaterThanOrEqual(128 * 32 * 4);
    expect(zeros.every((b) => b === 0)).toBe(true);
    // ... then the bitmap itself.
    expect((calls.at(-1) as Call).length).toBe(7);
  });

  it('clears the strip to the right of a narrower bitmap too, and never a fresh cell', () => {
    resident = want(9);
    land(9, 128, 128);
    land(1, 128, 128);
    um.forget(1);
    um.afterRender();
    um.afterRender();
    calls.length = 0;
    land(2, 96, 128);
    const clear = calls.slice(0, -1) as Call[];
    const cell = (calls.at(-1) as Call).slice(2, 4) as [number, number];
    expect(clear).toHaveLength(1);
    expect(clear[0].slice(2, 6)).toEqual([cell[0] + 96, cell[1], 32, 128]);
    // A cell nobody used before is already empty: just the bitmap.
    calls.length = 0;
    land(3, 100, 70);
    expect(calls).toHaveLength(1);
  });
});
