// @vitest-environment jsdom
// `Corkboard.create` and `dispose` against a stub stage: cleanup when a step throws, the abort signal, the
// `disposed` error on every method, and what `add` / `update` do with a value they cannot hold.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageOptions } from '../src/render/stage';
import type { Change } from '../src/types';

const h = vi.hoisted(() => ({
  stages: [] as unknown[],
  gate: null as Promise<void> | null,
  lastOptions: null as Record<string, unknown> | null,
  // Makes the board's `stage.onFrame` call throw: a constructor step that fails after the layers exist.
  failFrame: null as Error | null,
}));

vi.mock('../src/render/stage', () => ({
  GRID: 24,
  Stage: {
    async create(_host: HTMLElement, options: Record<string, unknown>) {
      h.lastOptions = options;
      if (h.gate) await h.gate;
      const stage = {
        attached: 0,
        disposed: 0,
        cam: {
          cam: { tx: 0, ty: 0, scale: 1 },
          scale: 1,
          width: 1280,
          height: 800,
          isEmpty: false,
          visibleRect: () => ({ x0: 0, y0: 0, x1: 1280, y1: 800 }),
        },
        attach() {
          stage.attached++;
        },
        dispose() {
          stage.disposed++;
        },
        onFrame: () => {
          if (h.failFrame) throw h.failFrame;
          return () => {};
        },
        onSettle: () => () => {},
        previewRectOf: () => undefined,
        activeTheme: () => 'dark',
        markDirty: () => {},
        fitRect: vi.fn(),
        boundsOf: () => undefined,
        setCamera: vi.fn(),
        setScaleRange: vi.fn(),
        setGrid: vi.fn(),
        setTheme: vi.fn(),
        stats: () => ({}),
      };
      h.stages.push(stage);
      return stage;
    },
  },
}));

import { Corkboard } from '../src/Corkboard';
import { CorkboardError } from '../src/errors';

type FakeStage = { attached: number; disposed: number };
const stageOf = (i = h.stages.length - 1) => h.stages[i] as FakeStage;

let host: HTMLElement;
beforeEach(() => {
  h.stages = [];
  h.gate = null;
  h.failFrame = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

const make = (o: Parameters<typeof Corkboard.create>[1] = {}) => Corkboard.create(host, { interaction: false, ...o });

describe('Corkboard.create failure', () => {
  it('disposes the stage and removes the overlay root and the layers when a constructor step throws', async () => {
    h.failFrame = new Error('frame boom');
    await expect(make()).rejects.toBe(h.failFrame);
    expect(stageOf().disposed).toBe(1);
    expect(host.children).toHaveLength(0);
  });
});

describe('Corkboard.create camera option', () => {
  it('rejects a zoom range that is not 0 < min <= max, before making a stage', async () => {
    for (const camera of [
      { minScale: 0 },
      { minScale: -1 },
      { maxScale: NaN },
      { minScale: Infinity },
      { minScale: 2, maxScale: 1 },
      { maxScale: 0.01 },
    ]) {
      await expect(make({ camera }), JSON.stringify(camera)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(h.stages).toHaveLength(0);
  });

  it('passes the range, and the signal, on to the stage', async () => {
    const ctl = new AbortController();
    const board = await make({ camera: { minScale: 0.01, maxScale: 8 }, signal: ctl.signal });
    const o = h.lastOptions as StageOptions;
    expect([o.minScale, o.maxScale]).toEqual([0.01, 8]);
    expect(o.signal).toBe(ctl.signal);
    board.dispose();
  });
});

describe('Corkboard.create signal', () => {
  it('rejects at once with the reason of a signal that is already aborted, making no stage', async () => {
    const reason = new Error('gone');
    const ctl = new AbortController();
    ctl.abort(reason);
    await expect(make({ signal: ctl.signal })).rejects.toBe(reason);
    expect(h.stages).toHaveLength(0);
  });

  it('disposes the stage that finishes after the abort, and rejects with the reason', async () => {
    let open!: () => void;
    h.gate = new Promise<void>((r) => (open = r));
    const ctl = new AbortController();
    const p = make({ signal: ctl.signal });
    ctl.abort(new Error('strict mode'));
    open();
    await expect(p).rejects.toThrow('strict mode');
    expect(stageOf().disposed).toBe(1);
    expect(host.children).toHaveLength(0);
  });

  it('does nothing once the board exists', async () => {
    const ctl = new AbortController();
    const board = await make({ signal: ctl.signal });
    ctl.abort();
    expect(stageOf().disposed).toBe(0);
    expect(() => board.add({ media: { src: 'a.jpg' } })).not.toThrow();
    board.dispose();
  });
});

describe('error events', () => {
  it('reach the board listeners from the stage callbacks, even before the board is built', async () => {
    const board = await make();
    const onError = vi.fn();
    const lost = vi.fn();
    const restored = vi.fn();
    board.on('error', onError);
    board.on('contextLost', lost);
    board.on('contextRestored', restored);
    const o = h.lastOptions as StageOptions;
    const e = { kind: 'worker' as const, cause: new Error('x') };
    o.onError?.(e);
    o.onContextLost?.();
    o.onContextRestored?.();
    expect(onError).toHaveBeenCalledWith(e);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(restored).toHaveBeenCalledTimes(1);
    board.dispose();
  });
});

describe('use after dispose', () => {
  it('throws CorkboardError("disposed") from every method, but not dispose, off or the getters', async () => {
    const board = await make();
    board.add({ id: 'a', x: 0, y: 0, w: 10, h: 10, media: { src: 'a.jpg' } });
    board.dispose();
    board.dispose();
    expect(stageOf().disposed).toBe(1);
    expect(host.children).toHaveLength(0);

    const calls: Record<string, () => unknown> = {
      add: () => board.add({ media: { src: 'b.jpg' } }),
      update: () => board.update('a', { x: 1 }),
      remove: () => board.remove('a'),
      clear: () => board.clear(),
      batch: () => board.batch(() => {}),
      getSnapshot: () => board.getSnapshot(),
      loadSnapshot: () => board.loadSnapshot({ format: 'corkboard', version: 1, elements: [] }),
      bringToFront: () => board.bringToFront(['a']),
      sendToBack: () => board.sendToBack(['a']),
      setOrder: () => board.setOrder(['a']),
      get: () => board.get('a'),
      all: () => board.all(),
      inRect: () => board.inRect({ x0: 0, y0: 0, x1: 1, y1: 1 }),
      bounds: () => board.bounds(),
      select: () => board.select(['a']),
      selectAll: () => board.selectAll(),
      setTheme: () => board.setTheme('light'),
      setGrid: () => board.setGrid(false),
      setSnapping: () => board.setSnapping(true),
      'video.setPaused': () => board.video.setPaused(true),
      'video.setOptions': () => board.video.setOptions({}),
      'embeds.setOptions': () => board.embeds.setOptions({}),
      'embeds.info': () => board.embeds.info('a'),
      'embeds.interact': () => board.embeds.interact('a'),
      'embeds.exitInteract': () => board.embeds.exitInteract(),
      on: () => board.on('change', () => {}),
      stats: () => board.stats(),
      screenRect: () => board.screenRect('a'),
      'camera.get': () => board.camera.get(),
      'camera.set': () => board.camera.set({ tx: 0, ty: 0, scale: 1 }),
      'camera.setRange': () => board.camera.setRange(0.1, 2),
      'camera.fit': () => board.camera.fit(),
      'camera.zoomTo': () => board.camera.zoomTo({ x0: 0, y0: 0, x1: 1, y1: 1 }),
      'camera.zoomBy': () => board.camera.zoomBy(2),
      'camera.actual': () => board.camera.actual(),
      'camera.center': () => board.camera.center(0, 0),
      'camera.visible': () => board.camera.visible(),
      'camera.screenToWorld': () => board.camera.screenToWorld(0, 0),
      'camera.worldToScreen': () => board.camera.worldToScreen(0, 0),
      'layout.tidy': () => board.layout.tidy(),
      'layout.masonry': () => board.layout.masonry(),
      'layout.align': () => board.layout.align('left'),
      'layout.distribute': () => board.layout.distribute('x'),
      'layout.equalWidth': () => board.layout.equalWidth(),
    };
    for (const [name, call] of Object.entries(calls)) {
      let err: unknown;
      try {
        call();
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(CorkboardError);
      expect((err as CorkboardError).code, name).toBe('disposed');
    }

    expect(() => board.off('change', () => {})).not.toThrow();
    expect(board.size).toBe(1);
    expect(board.selection).toEqual([]);
    expect(board.video.playing.size).toBe(0);
    expect(() => board.snapping).not.toThrow();
    expect(() => board.video.budget).not.toThrow();
    expect(() => board.video.paused).not.toThrow();
  });
});

describe('add / update validation', () => {
  it('rejects a bad batch whole: nothing is inserted and no event fires', async () => {
    const board = await make();
    const onChange = vi.fn();
    board.on('change', onChange);
    const ok = { id: 'ok', x: 0, y: 0, w: 10, h: 10, media: { src: 'a.jpg' } };
    expect(() => board.add([ok, { ...ok, id: 'bad', w: NaN }])).toThrow(CorkboardError);
    expect(() => board.add([ok, { ...ok }])).toThrow(/duplicate/);
    expect(board.size).toBe(0);
    expect(onChange).not.toHaveBeenCalled();

    board.add(ok);
    onChange.mockClear();
    expect(() => board.add([{ ...ok, id: 'new' }, { ...ok }])).toThrow(/already exists/);
    expect(board.size).toBe(1);
    expect(onChange).not.toHaveBeenCalled();
    board.dispose();
  });

  it('throws code "invalid" and leaves the card alone on a bad patch; unknown id is still false', async () => {
    const board = await make();
    board.add({ id: 'a', x: 5, y: 5, w: 10, h: 10, media: { src: 'a.jpg' } });
    const onChange = vi.fn();
    board.on('change', onChange);
    let err: unknown;
    try {
      board.update('a', { x: 99, w: 0 });
    } catch (e) {
      err = e;
    }
    expect((err as CorkboardError).code).toBe('invalid');
    expect(board.get('a')).toMatchObject({ x: 5, w: 10 });
    expect(onChange).not.toHaveBeenCalled();
    expect(board.update('ghost', { x: NaN })).toBe(false);
    board.dispose();
  });

  it('leaves every field alone for undefined; an own `data: undefined` clears data, null stores null', async () => {
    const board = await make();
    board.add({ id: 'a', x: 0, y: 0, w: 10, h: 10, media: { src: 'a.jpg' }, data: { k: 1 } });
    board.update('a', { x: undefined, data: undefined } as never);
    expect(board.get('a')?.data).toBeUndefined();
    expect(board.get('a')?.x).toBe(0);
    board.update('a', { data: { k: 2 } });
    board.update('a', { x: 3 });
    expect(board.get('a')?.data).toEqual({ k: 2 });
    board.update('a', { data: null });
    expect(board.get('a')?.data).toBeNull();
    const events: Change[] = [];
    board.on('change', (c) => events.push(c));
    board.update('a', { data: undefined });
    expect(events[0].updated[0].props).toEqual(['data']);
    board.update('a', { data: undefined });
    expect(events).toHaveLength(1);
    board.dispose();
  });
});

describe('Corkboard.isSupported', () => {
  it('is true when a webgl2 context can be made (and hands it back), false when not, never throws', () => {
    const lose = vi.fn();
    const gl = { getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext: lose } : null) };
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    spy.mockImplementation(((t: string) => (t === 'webgl2' ? gl : null)) as never);
    expect(Corkboard.isSupported()).toBe(true);
    expect(lose).toHaveBeenCalledTimes(1);
    spy.mockImplementation((() => null) as never);
    expect(Corkboard.isSupported()).toBe(false);
    spy.mockImplementation((() => {
      throw new Error('no');
    }) as never);
    expect(Corkboard.isSupported()).toBe(false);
  });
});

describe('injected styles', () => {
  const sheets = (): HTMLStyleElement[] =>
    [...document.head.querySelectorAll<HTMLStyleElement>('style')].filter(
      (s) => s.id === 'cb-embed-styles' || s.hasAttribute('data-corkboard-video'),
    );

  it('carry the nonce, are shared by the boards on a document and go with the last one', async () => {
    expect(sheets()).toHaveLength(0);
    const a = await make({ nonce: 'abc123' });
    const b = await make({ nonce: 'abc123' });
    // One embed sheet and one video sheet, not one per board.
    expect(sheets()).toHaveLength(2);
    for (const s of sheets()) expect(s.nonce).toBe('abc123');

    a.dispose();
    expect(sheets()).toHaveLength(2);
    b.dispose();
    expect(sheets()).toHaveLength(0);
  });

  it('are made without a nonce when none is given', async () => {
    const a = await make();
    for (const s of sheets()) expect(s.nonce || '').toBe('');
    a.dispose();
    expect(sheets()).toHaveLength(0);
  });

  it('are not left behind by a board whose creation failed', async () => {
    await expect(
      (async () => {
        h.failFrame = new Error('boom');
        return make({ nonce: 'n' });
      })(),
    ).rejects.toThrow('boom');
    expect(sheets()).toHaveLength(0);
  });
});
