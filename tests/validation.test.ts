// @vitest-environment jsdom
// What the board refuses up front: options (create and every setter), camera and layout arguments and id lists
// all throw `CorkboardError('invalid')` before anything is written or applied, never a raw TypeError and never a
// NaN in the store or the camera. The store itself refuses a card with a NaN position or a size <= 0.
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
          flyTo: vi.fn(),
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
        setPosterOverride: () => {},
        posterShown: () => false,
        fitRect: vi.fn(),
        boundsOf: vi.fn(() => undefined),
        setCamera: vi.fn(),
        setScaleRange: vi.fn(),
        setTheme: vi.fn(),
        setGrid: vi.fn(),
        zoomBy: vi.fn(),
        worldToScreen: (x: number, y: number) => ({ x, y }),
        screenToWorld: (x: number, y: number) => ({ x, y }),
        clearPreview: () => {},
        pin: () => {},
        stats: () => ({ cards: 0, mounted: 0 }),
      };
    },
  },
}));

import { Corkboard } from '../src/Corkboard';
import { CorkboardError } from '../src/errors';
import { getInternals } from '../src/internals';
import { Store } from '../src/store';
import { createElement } from '../src/model';
import { DARK_THEME } from '../src/render/theme';

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

const invalid = expect.objectContaining({ code: 'invalid', name: 'CorkboardError' });
const card = (id: string, x = 0) => ({ id, x, y: 0, w: 100, h: 80, media: { src: `${id}.jpg` } });
const make = async () => {
  const board = await Corkboard.create(host);
  board.add([card('a'), card('b', 200), card('c', 400)]);
  return board;
};

describe('layout options', () => {
  it('refuse a bad gap, columns, width or duration before writing anything', async () => {
    const board = await make();
    const before = JSON.stringify(board.getSnapshot());
    const bad: [string, () => void][] = [
      ['gap NaN', () => board.layout.tidy(undefined, { gap: NaN, animate: false })],
      ['gap -1', () => board.layout.tidy(undefined, { gap: -1 })],
      ['gap Infinity', () => board.layout.masonry(undefined, { gap: Infinity })],
      ['columns 0', () => board.layout.tidy(undefined, { columns: 0 })],
      ['columns 1.5', () => board.layout.masonry(undefined, { columns: 1.5 })],
      ['width -50', () => board.layout.masonry(undefined, { width: -50, animate: false })],
      ['width NaN', () => board.layout.masonry(undefined, { width: NaN, animate: false })],
      ['width 0', () => board.layout.masonry(undefined, { width: 0 })],
      ['duration NaN', () => board.layout.tidy(undefined, { duration: NaN })],
      ['duration -1', () => board.layout.equalWidth(undefined, { duration: -1 })],
      ['animate string', () => board.layout.align('left', undefined, { animate: 'yes' as never })],
      ['options null', () => board.layout.tidy(undefined, null as never)],
      ['align mode', () => board.layout.align('middle' as never)],
      ['distribute axis', () => board.layout.distribute('z' as never)],
    ];
    for (const [name, fn] of bad) expect(fn, name).toThrow(invalid);
    expect(JSON.stringify(board.getSnapshot())).toBe(before);
    // The board still loads its own snapshot.
    expect(() => board.loadSnapshot(JSON.parse(before))).not.toThrow();
    board.dispose();
  });

  it('accept one id or a list, and refuse anything else', async () => {
    const board = await make();
    expect(() => board.layout.equalWidth('a', { animate: false })).not.toThrow();
    expect(() => board.layout.tidy(['a', 'b'], { animate: false })).not.toThrow();
    for (const ids of [5, null, {}, [1], ['a', 2]]) {
      expect(() => board.layout.tidy(ids as never, { animate: false }), JSON.stringify(ids)).toThrow(invalid);
    }
    board.dispose();
  });

  it('refuse a layout that would write a rect with a NaN or Infinity (nothing is written)', async () => {
    const board = await make();
    const before = JSON.stringify(board.getSnapshot());
    expect(() => board.layout.masonry(undefined, { width: 1e308, gap: 1e308, columns: 2, animate: false })).toThrow(invalid);
    expect(JSON.stringify(board.getSnapshot())).toBe(before);
    board.dispose();
  });
});

describe('the store refuses broken geometry, whoever writes it', () => {
  it('add and update', () => {
    const store = new Store();
    const ok = createElement({ id: 'a', x: 0, y: 0, w: 100, h: 50, media: { src: 'a.jpg' } }, 'a');
    store.add([ok]);
    for (const patch of [{ x: NaN }, { y: Infinity }, { w: 0 }, { w: -3 }, { h: NaN }, { rot: NaN }]) {
      expect(() => store.update('a', patch), JSON.stringify(patch)).toThrow(invalid);
    }
    expect(store.get('a')).toBe(ok);
    expect(() => store.add([{ ...ok, id: 'b', x: NaN }])).toThrow(invalid);
    expect(store.has('b')).toBe(false);
  });
});

describe('camera arguments', () => {
  it('center, zoomBy, zoomTo and fit refuse NaN and other bad input', async () => {
    const board = await make();
    const calls: [string, () => void][] = [
      ['center x', () => board.camera.center(NaN, 0)],
      ['center y', () => board.camera.center(0, Infinity)],
      ['center scale', () => board.camera.center(0, 0, 0)],
      ['center scale NaN', () => board.camera.center(0, 0, NaN)],
      ['center options', () => board.camera.center(0, 0, 1, { animate: 1 as never })],
      ['zoomBy NaN', () => board.camera.zoomBy(NaN)],
      ['zoomBy 0', () => board.camera.zoomBy(0)],
      ['zoomBy -2', () => board.camera.zoomBy(-2)],
      ['zoomTo NaN', () => board.camera.zoomTo({ x0: NaN, y0: 0, x1: 10, y1: 10 })],
      ['zoomTo missing', () => board.camera.zoomTo(undefined as never)],
      ['zoomTo padding', () => board.camera.zoomTo({ x0: 0, y0: 0, x1: 1, y1: 1 }, { padding: -1 })],
      ['fit padding', () => board.camera.fit(undefined, { padding: NaN })],
      ['fit ids', () => board.camera.fit(7 as never)],
      ['screenToWorld', () => board.camera.screenToWorld(NaN, 0)],
      ['worldToScreen', () => board.camera.worldToScreen(0, undefined as never)],
    ];
    for (const [name, fn] of calls) expect(fn, name).toThrow(invalid);
    const stage = getInternals(board).stage;
    expect(stage.setCamera).not.toHaveBeenCalled();
    expect(stage.zoomBy).not.toHaveBeenCalled();
    expect(() => board.camera.center(10, 20, 2, { animate: false })).not.toThrow();
    expect(() => board.camera.fit('a')).not.toThrow();
    board.dispose();
  });
});

describe('options', () => {
  it('setTheme and the theme option refuse an unknown name or a broken Theme', async () => {
    const board = await make();
    for (const t of ['blue', null, 3, {}, { ...DARK_THEME, canvas: 'red' }, { ...DARK_THEME, borderAlpha: 2 }, { ...DARK_THEME, dark: 'yes' }]) {
      expect(() => board.setTheme(t as never), String(JSON.stringify(t))).toThrow(invalid);
    }
    expect(() => board.setTheme(undefined as never)).toThrow(invalid);
    expect(() => board.setTheme('light')).not.toThrow();
    expect(() => board.setTheme({ ...DARK_THEME, canvas: 0x123456 })).not.toThrow();
    await expect(Corkboard.create(host, { theme: 'blue' as never })).rejects.toMatchObject({ code: 'invalid' });
    board.dispose();
  });

  it('video.setOptions and embeds.setOptions refuse NaN, negatives and unknown enum values', async () => {
    const board = await make();
    const video: Record<string, unknown>[] = [{ maxPlaying: NaN }, { maxPlaying: -1 }, { maxPlayingTouch: 'x' }, { minPlayPx: NaN }, { mode: 'sometimes' }, { loop: 1 }];
    for (const o of video) expect(() => board.video.setOptions(o), JSON.stringify(o)).toThrow(invalid);
    const embeds: Record<string, unknown>[] = [
      { maxLive: -1 }, { maxLive: NaN }, { maxMounted: 'many' }, { maxLoading: -2 }, { maxAnimating: NaN }, { cullMargin: -1 },
      { minLivePx: NaN }, { minLivePx: { w: -1, h: 3 } }, { resolution: '4k' }, { resolution: -3 }, { snippetNetwork: 'all' },
      { previewWorkers: 1.5 }, { previewCache: 'disk' }, { freezePx: NaN }, { resolveTimeoutMs: -1 }, { resolve: 'x' }, { adaptive: 'yes' },
      { isolatedHosts: 'example.com' },
    ];
    for (const o of embeds) expect(() => board.embeds.setOptions(o), JSON.stringify(o)).toThrow(invalid);
    // Infinity is the documented "no cap", and an `undefined` field means "leave it".
    expect(() => board.video.setOptions({ maxPlaying: Infinity, mode: 'hover' })).not.toThrow();
    expect(() => board.embeds.setOptions({ maxLive: Infinity, maxMounted: Infinity, maxAnimating: Infinity, resolution: 'native', minLivePx: undefined })).not.toThrow();
    expect(() => board.interaction?.setOptions({ emptyDrag: 'rotate' as never })).toThrow(invalid);
    expect(() => board.interaction?.setOptions({ commit: 0 as never })).toThrow(invalid);
    expect(() => board.setSnapping({ guides: 'x' as never })).toThrow(invalid);
    expect(() => board.setSnapping(1 as never)).toThrow(invalid);
    expect(() => board.setGrid('on' as never)).toThrow(invalid);
    board.dispose();
  });

  it('create refuses bad options before it makes anything', async () => {
    const bad: (Record<string, unknown> | null)[] = [
      { textures: { budgetBytes: -1 } },
      { textures: { budgetBytes: NaN } },
      { textures: { workers: 0 } },
      { textures: { uploadBudgetMs: 0 } },
      { textures: { overscan: -1 } },
      { video: { maxPlaying: NaN } },
      { embeds: { maxLive: -1 } },
      { interaction: { emptyDrag: 'x' } },
      { interaction: 'yes' },
      { camera: { minScale: 5, maxScale: 1 } },
      { camera: { minScale: NaN } },
      { snapping: 'yes' },
      { grid: 'yes' },
      { cspSafe: 1 },
      { nonce: 5 },
      { signal: {} },
      null,
    ];
    for (const o of bad) {
      await expect(Corkboard.create(host, o as never), JSON.stringify(o)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(Corkboard.create(null as never)).rejects.toBeInstanceOf(CorkboardError);
    expect(host.childElementCount).toBe(0);
  });
});

describe('id lists', () => {
  it('every method that takes ids accepts one id or an array, and refuses other types with invalid', async () => {
    const board = await make();
    expect(() => board.select('a')).not.toThrow();
    expect(board.selection).toEqual(['a']);
    expect(() => board.select(['a', 'b'])).not.toThrow();
    expect(board.bounds('a')).toBeUndefined(); // the stub stage has no bounds
    expect(() => board.bringToFront('a')).not.toThrow();
    expect(() => board.sendToBack(['b'])).not.toThrow();
    const wrong = [5, null, {}, [1], ['a', {}]];
    for (const ids of wrong) {
      const name = JSON.stringify(ids);
      expect(() => board.select(ids as never), `select ${name}`).toThrow(invalid);
      expect(() => board.bounds(ids as never), `bounds ${name}`).toThrow(invalid);
      expect(() => board.remove(ids as never), `remove ${name}`).toThrow(invalid);
      expect(() => board.bringToFront(ids as never), `bringToFront ${name}`).toThrow(invalid);
      expect(() => board.sendToBack(ids as never), `sendToBack ${name}`).toThrow(invalid);
      expect(() => board.camera.fit(ids as never), `fit ${name}`).toThrow(invalid);
    }
    // setOrder needs the whole list, as an array.
    expect(() => board.setOrder('a' as never)).toThrow(invalid);
    expect(() => board.setOrder(['a', 'b'])).toThrow(invalid);
    expect(() => board.setOrder(['c', 'b', 'a'])).not.toThrow();
    expect(board.size).toBe(3);
    board.dispose();
  });
});
