// The public `Corkboard` pieces that need no WebGL: `add` (sizes and placement of new cards) and the
// camera's `fit`, run against a real Store and LayoutApi with a stub stage.
import { describe, expect, it, vi } from 'vitest';
// Corkboard.ts only needs the Stage type and `Stage.create`; loading Pixi in jsdom is noise.
vi.mock('../src/render/stage', () => ({ GRID: 24 }));
import { CameraApi, Corkboard } from '../src/Corkboard';
import { LayoutApi } from '../src/LayoutApi';
import { createElement } from '../src/model';
import type { Stage } from '../src/render/stage';
import { Store } from '../src/store';
import { DEFAULTS, type ElementInit } from '../src/types';

function stubStage() {
  return {
    cam: {
      scale: 1,
      width: 1280,
      height: 800,
      isEmpty: false,
      visibleRect: () => ({ x0: 0, y0: 0, x1: 1280, y1: 800 }),
    },
    fitRect: vi.fn(),
    contentBounds: () => ({ x0: 0, y0: 0, x1: 1, y1: 1 }),
  };
}

const card = (id: string): ElementInit & { id: string } => ({ id, x: 0, y: 0, w: 100, h: 100, media: { src: `${id}.jpg` } });

describe('camera.fit', () => {
  function make(ids: string[] = []) {
    const store = new Store();
    store.add(ids.map((id) => createElement(card(id), id)));
    const stage = stubStage();
    return { stage, camera: new CameraApi(stage as unknown as Stage, store) };
  }

  it('does nothing on an empty board', () => {
    const { stage, camera } = make();
    camera.fit();
    camera.fit(undefined, { animate: false });
    expect(stage.fitRect).not.toHaveBeenCalled();
  });

  it('does nothing when there is no id to fit: an empty list, a selection that is empty, ids that are not cards', () => {
    const { stage, camera } = make(['a']);
    camera.fit([]);
    camera.fit(['ghost']);
    expect(stage.fitRect).not.toHaveBeenCalled();
  });

  it('fits the board, or the ids that are cards', () => {
    const { stage, camera } = make(['a', 'b']);
    camera.fit();
    camera.fit(['b', 'ghost']);
    expect(stage.fitRect).toHaveBeenCalledTimes(2);
  });
});

describe('Corkboard.add', () => {
  // `add` only reads the store and the layout api: run it on those.
  function make() {
    const store = new Store();
    const layout = new LayoutApi(store, stubStage() as unknown as Stage);
    const add = (input: ElementInit | ElementInit[]) =>
      Corkboard.prototype.add.call({ store, layout } as unknown as Corkboard, input).map((id) => store.get(id)!);
    return { store, add };
  }

  it('an embed with no size is as wide as the default embed width, and big enough to go live', () => {
    const { add } = make();
    const [e] = add({ media: { embed: { url: 'https://example.com/page' } } });
    expect(e.w).toBe(DEFAULTS.embedWidth);
    expect(e.h).toBe(Math.round(DEFAULTS.embedWidth * DEFAULTS.embedAspect));
    // The default `minLivePx` of the embed layer is 320 x 200.
    expect(e.w).toBeGreaterThanOrEqual(320);
    expect(e.h).toBeGreaterThanOrEqual(200);
  });

  it('keeps a given size, and an embed block does not overlap', () => {
    const { add } = make();
    const [a, b, c] = add([
      { media: { embed: { url: 'https://example.com/1' } } },
      { media: { embed: { url: 'https://example.com/2' } }, w: 500 },
      { media: { embed: { html: '<p>x</p>' } } },
    ]);
    expect([a.w, b.w, c.w]).toEqual([DEFAULTS.embedWidth, 500, DEFAULTS.embedWidth]);
    const list = [a, b, c];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i];
        const q = list[j];
        const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
        expect(apart, `${i} / ${j}`).toBe(true);
      }
    }
  });

  it('an image with no size still takes the placement width', () => {
    const { add } = make();
    const [i] = add({ media: { src: 'a.jpg' } });
    expect(i.w).toBe(DEFAULTS.cardWidth);
  });

  it('keeps the x or the y a card has, and places the other', () => {
    const { add } = make();
    const [onlyX] = add({ media: { src: 'a.jpg' }, x: 5000 });
    expect(onlyX.x).toBe(5000);
    expect(Number.isFinite(onlyX.y)).toBe(true);
    const [onlyY] = add({ media: { src: 'b.jpg' }, y: -4000 });
    expect(onlyY.y).toBe(-4000);
    expect(Number.isFinite(onlyY.x)).toBe(true);
  });

  it('leaves a card with both coordinates exactly where it was put', () => {
    const { add } = make();
    const [c] = add({ media: { src: 'a.jpg' }, x: 12, y: 34 });
    expect([c.x, c.y]).toEqual([12, 34]);
  });
});
