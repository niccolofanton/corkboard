// The embed layer against a real Store and a stub stage: what it mounts, with which attributes, how many,
// and how interact mode behaves. Posters need canvas and network, which jsdom has not: they are not under
// test here (the tile and provider logic is, in their own files).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const drawTile = vi.hoisted(() => vi.fn<(spec: { title: string }) => Promise<Blob | null>>(async () => null));
vi.mock('../../src/embed/tile', async (orig) => ({
  ...(await orig<typeof import('../../src/embed/tile')>()),
  drawTile,
}));
import { EmbedLayer, type EmbedEvents, type EmbedLayerDeps } from '../../src/embed/layer';
import { MIN_LIVE_SCALE } from '../../src/embed/policy';
import {
  CULL_SNAPSHOT_MIN_MS,
  CULL_SNAPSHOT_MS,
  LOAD_SLOT_MS,
  MAX_LOADING,
  MAX_SNAPSHOTS,
  PREVIEW_JOB_MS,
  PREVIEW_SETTLE_MS,
} from '../../src/embed/layer';
import { createElement } from '../../src/model';
import { FrameRateMonitor } from '../../src/render/frameRate';
import { DARK_THEME } from '../../src/render/theme';
import type { Stage } from '../../src/render/stage';
import { Store } from '../../src/store';
import type { ElementInit } from '../../src/types';

const VIEW = { w: 1600, h: 1000 };
// jsdom fires a `load` of its own on every iframe it attaches, a turn after the layer mounts it. The layer treats
// every load as a new document, so only the ones a test sends (made here) reach it.
const sent = new WeakSet<Event>();
const loadEvent = (): Event => {
  const e = new Event('load');
  sent.add(e);
  return e;
};
// Cards whose poster texture has not landed on the fake stage yet.
const unlanded = new Set<string>();

// `fitRect` lands at once, the way the real camera does when its fly is over (clamped to `maxScale`).
const stageOf = new WeakMap<Store, { overrides: Map<string, string> }>();
// The runtime poster the layer set on a card (never in the store).
const posterOf = (store: Store, id: string): string | undefined => stageOf.get(store)?.overrides.get(id);

function fakeStage(store: Store, scale = 1, maxScale = 4) {
  const cam = { tx: 0, ty: 0, scale };
  // Runtime posters by card, the way the stage keeps them (a removed card drops its own).
  const overrides = new Map<string, string>();
  const stage = {
    overrides,
    // Every call, in order: null is a drop.
    overrideCalls: [] as [string, string | null][],
    setPosterOverride(id: string, url: string | null) {
      this.overrideCalls.push([id, url]);
      if (url === null) overrides.delete(id);
      else overrides.set(id, url);
    },
    // The sprite of a card shows its current poster unless a test says its texture has not landed.
    posterShown: (id: string) => !unlanded.has(id),
    cam: {
      cam,
      get scale() {
        return cam.scale;
      },
      width: VIEW.w,
      height: VIEW.h,
      visibleRect: () => ({ x0: -cam.tx / cam.scale, y0: -cam.ty / cam.scale, x1: (VIEW.w - cam.tx) / cam.scale, y1: (VIEW.h - cam.ty) / cam.scale }),
    },
    activeTheme: DARK_THEME,
    previewRectOf: () => undefined,
    markDirty: () => {},
    fitRect: vi.fn((r: { x0: number; y0: number; x1: number; y1: number }, _animate?: boolean, pad = 48) => {
      const w = Math.max(1, r.x1 - r.x0);
      const h = Math.max(1, r.y1 - r.y0);
      const k = Math.min(maxScale, Math.max(0.05, Math.min((VIEW.w - pad * 2) / w, (VIEW.h - pad * 2) / h)));
      cam.scale = k;
      cam.tx = (VIEW.w - w * k) / 2 - r.x0 * k;
      cam.ty = (VIEW.h - h * k) / 2 - r.y0 * k;
    }),
    contentBounds: (ids: string[]) => {
      const el = store.get(ids[0])!;
      return { x0: el.x, y0: el.y, x1: el.x + el.w, y1: el.y + el.h };
    },
  };
  stageOf.set(store, stage);
  return { stage: stage as unknown as Stage & { overrides: Map<string, string>; overrideCalls: [string, string | null][] }, cam };
}

let n = 0;
const embed = (init: Partial<ElementInit> & Pick<ElementInit, 'media'>) =>
  createElement({ w: 480, h: 300, x: 0, y: 0, ...init }, `e${n++}`);

let host: HTMLElement;
let root: HTMLElement;
let events: Array<[string, unknown]>;
const dropJsdomLoad = (e: Event): void => {
  if (!sent.has(e)) e.stopImmediatePropagation();
};
beforeEach(() => {
  document.addEventListener('load', dropJsdomLoad, true);
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  document.body.innerHTML = '<div id="host" tabindex="0"><div id="root"></div></div>';
  host = document.getElementById('host') as HTMLElement;
  root = document.getElementById('root') as HTMLElement;
  events = [];
  unlanded.clear();
});
// Layers a test made and did not dispose: their timers (a preview job's, a heartbeat) would otherwise fire in a
// later test and put studios or frames in its document.
const made: EmbedLayer[] = [];
afterEach(() => {
  for (const l of made.splice(0)) l.dispose();
  document.removeEventListener('load', dropJsdomLoad, true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  drawTile.mockReset();
  drawTile.mockResolvedValue(null);
});

function make(scale = 1, opts = {}, maxScale = 4, deps: Partial<EmbedLayerDeps> = {}) {
  const store = new Store();
  const { stage, cam } = fakeStage(store, scale, maxScale);
  const layer = new EmbedLayer(
    {
      root,
      host,
      store,
      stage,
      emit: <K extends keyof EmbedEvents>(type: K, payload: EmbedEvents[K]) => void events.push([type, payload]),
      // Nothing rasterises in jsdom: every picture is a small blob unless a test says otherwise.
      rasterize: async () => new Blob(['img'], { type: 'image/webp' }),
      ...deps,
    },
    opts,
  );
  made.push(layer);
  const frames = () => [...root.querySelectorAll<HTMLIFrameElement>('.cb-embed iframe')];
  // What the board does: a frame after the change, then the camera settles.
  const tick = () => {
    layer.onFrame(false);
    layer.onSettle();
  };
  return { store, layer, stage, cam, frames, tick };
}

// The size and zoom thresholds a host can opt into (the default mounts any card in view).
const THRESH = { minLivePx: 320, minLiveScale: MIN_LIVE_SCALE };

const yt = (i = 0) => ({ media: { embed: { url: `https://youtu.be/dQw4w9WgX${String(i).padStart(2, '0')}`.slice(0, 31) } } });

describe('EmbedLayer', () => {
  it('mounts one sandboxed iframe for a big card, with the provider profile', () => {
    const { store, frames, tick } = make();
    store.add([embed(yt())]);
    tick();
    const f = frames();
    expect(f).toHaveLength(1);
    // The player API is on (so the layer can pause it); the stored info keeps the plain URL.
    expect(f[0].getAttribute('src')).toBe(`https://www.youtube-nocookie.com/embed/dQw4w9WgX00?enablejsapi=1&origin=${encodeURIComponent(location.origin)}`);
    expect(f[0].getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-presentation');
    expect(f[0].getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(f[0].getAttribute('loading')).toBe('lazy');
    expect(f[0].getAttribute('allow')).toContain('encrypted-media');
    expect(events).toContainEqual(['embedLive', expect.objectContaining({ live: true })]);
  });

  it('rounds the frame like the card: the radius scaled from world px to the layout box', () => {
    const { store, tick } = make();
    store.add([embed({ ...yt(), w: 480, h: 270, radius: 12 })]);
    tick();
    const w = root.querySelector<HTMLElement>('.cb-embed') as HTMLElement;
    // 270 world px tall is laid out 720 px tall (the 720p virtual screen): 12 x 720 / 270.
    expect(parseFloat(w.style.borderRadius)).toBeCloseTo((12 * parseFloat(w.style.width)) / 480, 1);
    expect(parseFloat(w.style.borderRadius)).toBeGreaterThan(12);
  });

  it('runs a snippet through srcdoc with scripts only and the CSP', () => {
    const { store, frames, tick } = make();
    store.add([embed({ media: { embed: { html: '<b id="x">hi</b>' } } })]);
    tick();
    const f = frames()[0];
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.hasAttribute('src')).toBe(false);
    expect(f.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(f.getAttribute('srcdoc')).toContain('<b id="x">hi</b>');
  });

  it('leaves a small card as a poster, and mounts it once selected', () => {
    const { store, layer, frames, tick } = make(0.4, THRESH);
    store.add([embed({ ...yt(), w: 480, h: 270 })]);
    const id = [...store.ids()][0];
    tick();
    expect(frames()).toHaveLength(0);
    layer.setSelection([id]);
    tick();
    expect(frames()).toHaveLength(1);
  });

  it('never mounts below the minimum zoom, even selected', () => {
    const { store, layer, frames, tick } = make(0.1, THRESH);
    store.add([embed(yt())]);
    layer.setSelection([...store.ids()]);
    tick();
    expect(frames()).toHaveLength(0);
  });

  it('mounts any card in view by default, whatever its size or zoom', () => {
    const { store, frames, tick } = make(0.1);
    store.add([embed({ ...yt(), w: 480, h: 270 })]);
    tick();
    expect(frames()).toHaveLength(1);
  });

  it('waits for the camera to settle', () => {
    const { store, frames, layer } = make();
    store.add([embed(yt())]);
    layer.onFrame(true);
    expect(frames()).toHaveLength(0);
    layer.onSettle();
    expect(frames()).toHaveLength(1);
  });

  it('never exceeds maxLive and keeps the cap when it changes', () => {
    const { store, layer, frames, tick } = make(1, { maxLive: 2 });
    store.add(Array.from({ length: 6 }, (_, i) => embed({ ...yt(i), x: (i % 3) * 500, y: Math.floor(i / 3) * 320 })));
    tick();
    expect(frames()).toHaveLength(2);
    expect(layer.live.size).toBe(2);
    layer.setOptions({ maxLive: 3 });
    tick();
    expect(frames()).toHaveLength(3);
    layer.setOptions({ maxLive: 1 });
    tick();
    // The two cards that lost their live slot stay mounted, parked (maxMounted is 12).
    expect(frames()).toHaveLength(3);
    expect(layer.parked.size).toBe(2);
  });

  it('allows three live iframes on touch', () => {
    const { store, layer, frames, tick } = make(0.5);
    store.add(Array.from({ length: 5 }, (_, i) => embed({ ...yt(i), x: i * 500 })));
    layer.setTouch(true);
    tick();
    expect(frames()).toHaveLength(3);
    expect(layer.maxLive).toBe(3);
  });

  it('evicts the least recently used live card for a selected one, and destroys its iframe past maxMounted', () => {
    const { store, layer, frames, tick } = make(1, { maxLive: 2, maxMounted: 2 });
    const els = Array.from({ length: 3 }, (_, i) => embed({ ...yt(i), x: i * 500 }));
    store.add(els);
    layer.setSelection([els[0].id]);
    tick();
    layer.setSelection([els[1].id]);
    tick();
    expect(layer.live).toEqual(new Set([els[0].id, els[1].id]));
    const dropped = frames().find((f) => f.getAttribute('src')?.includes('/embed/dQw4w9WgX00')) as HTMLIFrameElement;
    layer.setSelection([els[2].id]);
    tick();
    expect(layer.live).toEqual(new Set([els[1].id, els[2].id]));
    expect(frames()).toHaveLength(2);
    expect(dropped.isConnected).toBe(false);
    expect(dropped.getAttribute('src')).toBe('about:blank');
  });

  describe('parked frames', () => {
    const mountOne = (scale = 1, opts: object = THRESH) => {
      const t = make(scale, opts);
      const el = embed(yt());
      t.store.add([el]);
      t.tick();
      expect(t.frames()).toHaveLength(1);
      return { ...t, el, wrapper: root.querySelector('.cb-embed') as HTMLElement };
    };
    const liveEvents = (live: boolean) => events.filter(([t, p]) => t === 'embedLive' && (p as { live: boolean }).live === live);

    it('parks a live card that shrank instead of going back to its poster', () => {
      const { layer, cam, frames, tick, el, wrapper } = mountOne();
      expect(layer.parked.size).toBe(0);
      cam.scale = 0.3; // 144 x 90 on screen, under the keep size
      tick();
      expect(frames()).toHaveLength(1);
      expect(layer.live.has(el.id)).toBe(true);
      expect(layer.parked).toEqual(new Set([el.id]));
      expect(wrapper.dataset.parked).toBeDefined();
      expect(wrapper.isConnected).toBe(true);
      expect(liveEvents(false)).toHaveLength(0);
    });

    it('parks a live card zoomed out below the minimum zoom, even selected', () => {
      const { layer, cam, frames, tick, el } = mountOne();
      layer.setSelection([el.id]);
      cam.scale = MIN_LIVE_SCALE - 0.05;
      tick();
      expect(frames()).toHaveLength(1);
      expect(layer.parked.has(el.id)).toBe(true);
    });

    it('keeps a parked card inert and out of interact mode', () => {
      const { layer, cam, tick, el, wrapper } = mountOne();
      layer.setSelection([el.id]);
      expect(layer.interact(el.id)).toBe(true);
      expect(wrapper.dataset.interact).toBeDefined();
      cam.tx = -5000; // off screen: no longer eligible
      tick();
      expect(layer.parked.has(el.id)).toBe(true);
      expect(layer.interacting).toBeNull();
      expect(wrapper.dataset.interact).toBeUndefined();
      expect(wrapper.querySelector('iframe')?.isConnected).toBe(true);
    });

    it('moves a parked card that regrew back to active without mounting it again', () => {
      const { layer, cam, frames, tick, el, wrapper } = mountOne();
      cam.scale = 0.3;
      tick();
      expect(layer.parked.has(el.id)).toBe(true);
      const iframe = frames()[0];
      cam.scale = 1;
      tick();
      expect(layer.parked.size).toBe(0);
      expect(wrapper.dataset.parked).toBeUndefined();
      expect(frames()).toEqual([iframe]);
      expect(liveEvents(true)).toHaveLength(1);
      expect(liveEvents(false)).toHaveLength(0);
    });

    it('changes nothing while the camera moves', () => {
      const { layer, cam, frames } = mountOne();
      cam.scale = 0.3;
      layer.onFrame(true);
      expect(layer.parked.size).toBe(0);
      expect(frames()).toHaveLength(1);
    });

    it('destroys the overflow past maxMounted, the off-screen frame first', () => {
      const { store, layer, cam, frames, tick } = make(1, { cullMargin: 0.25 });
      const [e0, e1, e2] = [embed({ ...yt(0), x: 0 }), embed({ ...yt(1), x: 2100 }), embed({ ...yt(2), x: 800 })];
      store.add([e0]);
      tick();
      cam.tx = -1300; // only e1 is in view (e0 is past the cull margin too)
      store.add([e1]);
      layer.setSelection([e1.id]);
      tick();
      expect(layer.live).toEqual(new Set([e0.id, e1.id]));
      expect(layer.parked).toEqual(new Set([e0.id]));
      cam.tx = 0; // e1 is off screen now (past the cull margin), though used more recently than e0
      layer.setSelection([]);
      store.add([e2]);
      tick();
      expect(layer.live).toEqual(new Set([e0.id, e1.id, e2.id]));
      layer.setOptions({ maxLive: 1, maxMounted: 2 });
      tick();
      expect(layer.live).toEqual(new Set([e0.id, e2.id]));
      expect(frames()).toHaveLength(2);
      // Last: the least recently used of the on-screen ones goes next.
      layer.setOptions({ maxMounted: 1 });
      tick();
      expect(layer.live).toEqual(new Set([e2.id]));
    });

    it('uses maxMountedTouch on touch', () => {
      const { layer } = make(1, { maxMounted: 7, maxMountedTouch: 2 });
      expect(layer.maxMounted).toBe(7);
      layer.setTouch(true);
      expect(layer.maxMounted).toBe(2);
      layer.setOptions({ maxMountedTouch: 5 });
      expect(layer.maxMounted).toBe(5);
    });

    it('destroys parked frames when the card is removed and on dispose', () => {
      const { store, layer, cam, frames, tick, el } = mountOne();
      const e2 = embed({ ...yt(1), x: 600 });
      store.add([e2]);
      tick();
      cam.scale = 0.3;
      tick();
      expect(layer.parked.size).toBe(2);
      store.remove([el.id]);
      expect(frames()).toHaveLength(1);
      layer.dispose();
      expect(frames()).toHaveLength(0);
    });
  });

  it('destroys the iframe of a removed card', () => {
    const { store, layer, frames, tick } = make();
    const el = embed(yt());
    store.add([el]);
    tick();
    store.remove([el.id]);
    expect(frames()).toHaveLength(0);
    expect(layer.live.size).toBe(0);
  });

  it('never mounts a card the resolver says cannot be framed, and opens it in a tab on interact', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const { store, layer, frames, tick } = make(1, { resolve: () => ({ frameable: false }) });
    const el = embed({ media: { embed: { url: 'https://github.com' } } });
    store.add([el]);
    return Promise.resolve().then(() => Promise.resolve()).then(() => {
      tick();
      layer.setSelection([el.id]);
      tick();
      expect(frames()).toHaveLength(0);
      expect(layer.info(el.id)?.frameable).toBe(false);
      layer.onDblClick(el.id);
      expect(open).toHaveBeenCalledWith('https://github.com/', '_blank', 'noopener,noreferrer');
      expect(layer.interacting).toBeNull();
    });
  });

  it('refuses a javascript: URL: a bookmark that opens nothing live', () => {
    const { store, frames, tick, layer } = make();
    const el = embed({ media: { embed: { url: 'javascript:alert(1)' } } });
    store.add([el]);
    layer.setSelection([el.id]);
    tick();
    expect(frames()).toHaveLength(0);
  });

  describe('interact mode', () => {
    it('takes pointer events and shows Done; Done, Esc, click outside and deselect leave it', () => {
      const { store, layer, frames, tick } = make();
      const el = embed(yt());
      store.add([el]);
      tick();
      const wrapper = () => root.querySelector('.cb-embed') as HTMLElement;
      const done = root.querySelector('.cb-embed-done') as HTMLButtonElement;
      expect(wrapper().hasAttribute('data-interact')).toBe(false);
      expect(done.style.display).not.toBe('block');

      layer.setSelection([el.id]);
      layer.onDblClick(el.id);
      expect(layer.interacting).toBe(el.id);
      expect(wrapper().hasAttribute('data-interact')).toBe(true);
      expect(done.style.display).toBe('block');
      expect(events).toContainEqual(['embedInteract', { id: el.id, active: true }]);

      done.click();
      expect(layer.interacting).toBeNull();
      expect(wrapper().hasAttribute('data-interact')).toBe(false);
      expect(events).toContainEqual(['embedInteract', { id: el.id, active: false }]);

      layer.onDblClick(el.id);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(layer.interacting).toBeNull();

      layer.onDblClick(el.id);
      host.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      expect(layer.interacting).toBeNull();

      layer.onDblClick(el.id);
      // A pointerdown inside the frame's wrapper does not end it.
      frames()[0].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      expect(layer.interacting).toBe(el.id);
      layer.setSelection([]);
      expect(layer.interacting).toBeNull();
    });

    it('Enter on the host with one selected embed enters it', () => {
      const { store, layer, tick } = make();
      const el = embed(yt());
      store.add([el]);
      layer.setSelection([el.id]);
      tick();
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(layer.interacting).toBe(el.id);
    });

    it('makes a small selected card live to interact with it', () => {
      const { store, layer, frames } = make(0.4);
      const el = embed(yt());
      store.add([el]);
      layer.setSelection([el.id]);
      layer.onDblClick(el.id);
      expect(frames()).toHaveLength(1);
      expect(layer.interacting).toBe(el.id);
    });

    it('flies in first when the board is zoomed too far out', () => {
      const { store, layer, stage, cam, frames } = make(0.1);
      const el = embed(yt());
      store.add([el]);
      layer.onDblClick(el.id);
      expect(layer.interacting).toBeNull();
      expect((stage.fitRect as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      cam.scale = 1;
      layer.onSettle();
      expect(layer.interacting).toBe(el.id);
      expect(frames()).toHaveLength(1);
    });

    it('flies in on a card too big to fit above the minimum zoom, centred, and interacts once', () => {
      // 600 x 4000 in a 1600 x 1000 view fits at 0.226, under the 0.25 a frame mounts at.
      const { store, layer, stage, cam, frames } = make(0.1);
      const el = embed({ ...yt(), x: 100, y: 200, w: 600, h: 4000 });
      store.add([el]);
      layer.setSelection([el.id]);
      layer.onDblClick(el.id);
      expect(layer.interacting).toBeNull();
      expect(cam.scale).toBeGreaterThanOrEqual(MIN_LIVE_SCALE);
      // The card's centre is the screen's.
      expect(cam.tx + 400 * cam.scale).toBeCloseTo(VIEW.w / 2);
      expect(cam.ty + 2200 * cam.scale).toBeCloseTo(VIEW.h / 2);
      layer.onSettle();
      expect(layer.interacting).toBe(el.id);
      expect(frames()).toHaveLength(1);
      expect(stage.fitRect).toHaveBeenCalledTimes(1);
    });

    it('still fits a card that fits above the minimum zoom', () => {
      const { store, layer, stage, cam } = make(0.1);
      const el = embed({ ...yt(), x: 0, y: 0, w: 480, h: 300 });
      store.add([el]);
      layer.setSelection([el.id]);
      layer.onDblClick(el.id);
      expect(stage.fitRect).toHaveBeenCalledWith({ x0: 0, y0: 0, x1: 480, y1: 300 }, true, 48);
      expect(cam.scale).toBeCloseTo(Math.min(1504 / 480, 904 / 300));
    });

    it('tries once when the camera cannot get in far enough, and a later zoom does not fire it', () => {
      const { store, layer, stage, cam } = make(0.1, {}, 0.2);
      const el = embed(yt());
      store.add([el]);
      layer.setSelection([el.id]);
      layer.onDblClick(el.id);
      layer.onSettle();
      expect(layer.interacting).toBeNull();
      expect(stage.fitRect).toHaveBeenCalledTimes(1);
      // More settles, and a zoom in later on: nothing is pending any more.
      layer.onSettle();
      cam.scale = 1;
      layer.onSettle();
      expect(layer.interacting).toBeNull();
      expect(stage.fitRect).toHaveBeenCalledTimes(1);
    });

    it('drops a pending interact when the card is deselected', () => {
      const { store, layer, cam } = make(0.1);
      const el = embed(yt());
      store.add([el]);
      layer.setSelection([el.id]);
      layer.onDblClick(el.id);
      // The same card selected again keeps it ...
      layer.setSelection([el.id]);
      // ... but not another selection, or none.
      layer.setSelection([]);
      cam.scale = 1;
      layer.onSettle();
      expect(layer.interacting).toBeNull();
    });
  });

  it('lays the wrapper out at a 720p screen by default, scaled onto the card by one transform', () => {
    const { store, cam, frames, tick } = make();
    cam.tx = 30;
    cam.ty = 40;
    cam.scale = 2;
    store.add([embed({ ...yt(), x: 10, y: 20, w: 480, h: 300 })]);
    tick();
    const w = frames()[0].parentElement as HTMLElement;
    expect(w.style.width).toBe('1152px');
    expect(w.style.height).toBe('720px');
    expect(w.style.transform).toBe('translate(50px, 80px) scale(0.833333)');
  });

  it('switches resolution live: 1080p, then native (world size)', () => {
    const { store, layer, cam, frames, tick } = make();
    cam.tx = 30;
    cam.ty = 40;
    cam.scale = 2;
    store.add([embed({ ...yt(), x: 10, y: 20, w: 480, h: 300 })]);
    tick();
    const w = frames()[0].parentElement as HTMLElement;
    layer.setOptions({ resolution: '1080p' });
    expect([w.style.width, w.style.height]).toEqual(['1728px', '1080px']);
    layer.setOptions({ resolution: 'native' });
    expect([w.style.width, w.style.height]).toEqual(['480px', '300px']);
    expect(w.style.transform).toBe('translate(50px, 80px) scale(2)');
  });

  describe('posters made by the layer', () => {
    let blobs = 0;
    const revoked: string[] = [];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    beforeEach(() => {
      blobs = 0;
      revoked.length = 0;
      URL.createObjectURL = () => `blob:made-${blobs++}`;
      URL.revokeObjectURL = (u: string) => void revoked.push(u);
      drawTile.mockResolvedValue(new Blob(['x']));
    });
    afterEach(() => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    });
    const resolved = () => events.filter(([t]) => t === 'embedResolved').map(([, p]) => p as EmbedEvents['embedResolved']);

    it('replaces a dead blob: poster that came back with a saved board, and does not report it', async () => {
      const { store } = make();
      const el = embed({ media: { src: 'blob:http://localhost/dead', embed: { url: 'https://example.com/post' } } });
      store.add([el]);
      await vi.waitFor(() => expect(resolved()).toHaveLength(1));
      expect(posterOf(store, el.id)).toBe('blob:made-0');
      expect(resolved()[0].poster).toBeUndefined();
    });

    it('never reports its own blob as the persistable poster, but keeps and reports the host\'s https one', async () => {
      const { store } = make();
      const own = embed({ media: { embed: { url: 'https://example.com/a' } } });
      const host = embed({ media: { src: 'https://cdn.example/p.jpg', embed: { url: 'https://example.com/b' } } });
      store.add([own, host]);
      await vi.waitFor(() => expect(resolved()).toHaveLength(2));
      expect(resolved().find((r) => r.id === own.id)?.poster).toBeUndefined();
      expect(resolved().find((r) => r.id === host.id)?.poster).toBe('https://cdn.example/p.jpg');
      expect(store.get(host.id)?.media.src).toBe('https://cdn.example/p.jpg');
      expect(posterOf(store, own.id)).toBe('blob:made-0');
    });

    it('redraws its tile when only the title changes, without resolving again', async () => {
      const resolve = vi.fn(() => ({ title: 'From resolver' }));
      const { store } = make(1, { resolve });
      const el = embed({ media: { embed: { url: 'https://example.com/a', title: 'Old' } } });
      store.add([el]);
      await vi.waitFor(() => expect(resolved()).toHaveLength(1));
      expect(drawTile).toHaveBeenCalledTimes(1);
      expect(drawTile.mock.calls[0][0].title).toBe('Old');
      const media = store.get(el.id)!.media;
      store.update(el.id, { media: { ...media, embed: { ...media.embed!, title: 'New' } } });
      await vi.waitFor(() => expect(drawTile).toHaveBeenCalledTimes(2));
      expect(drawTile.mock.calls[1][0].title).toBe('New');
      await vi.waitFor(() => expect(posterOf(store, el.id)).toBe('blob:made-1'));
      // Dropping the card's own title falls back to the resolver's.
      const media2 = store.get(el.id)!.media;
      store.update(el.id, { media: { ...media2, embed: { url: 'https://example.com/a' } } });
      await vi.waitFor(() => expect(drawTile).toHaveBeenCalledTimes(3));
      expect(drawTile.mock.calls[2][0].title).toBe('From resolver');
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it('never writes a poster to the store: the card keeps the media the host gave it and no change is emitted', async () => {
      const { store } = make();
      const own = embed({ media: { embed: { url: 'https://example.com/a', title: 'T' } } });
      const dead = embed({ media: { src: 'blob:http://localhost/dead', embed: { url: 'https://example.com/b' } } });
      store.add([own, dead]);
      await vi.waitFor(() => expect(resolved()).toHaveLength(2));
      expect(posterOf(store, own.id)).toBe('blob:made-0');
      const changes: unknown[] = [];
      store.subscribe((e) => void changes.push(e));
      // A tile redrawn for a new title is one more poster, still no store change.
      const media = store.get(own.id)!.media;
      store.update(own.id, { media: { ...media, embed: { ...media.embed!, title: 'New' } } });
      changes.length = 0;
      await vi.waitFor(() => expect(posterOf(store, own.id)).toBe('blob:made-2'));
      expect(changes).toEqual([]);
      expect(store.get(own.id)?.media.src).toBeUndefined();
      // The dead blob of an old saved board is left as it was: the override stands in for it.
      expect(store.get(dead.id)?.media.src).toBe('blob:http://localhost/dead');
    });

    it('lets a picture of the host\'s win over a tile, also when it comes later, and gives the tile back when it goes', async () => {
      const { store, stage } = make();
      const el = embed({ media: { embed: { url: 'https://example.com/a' } } });
      store.add([el]);
      await vi.waitFor(() => expect(resolved()).toHaveLength(1));
      expect(posterOf(store, el.id)).toBe('blob:made-0');
      const media = store.get(el.id)!.media;
      store.update(el.id, { media: { ...media, src: 'https://cdn.example/p.jpg' } });
      expect(posterOf(store, el.id)).toBeUndefined();
      store.update(el.id, { media: { ...media, src: undefined } });
      expect(posterOf(store, el.id)).toBe('blob:made-0');
      expect(stage.overrideCalls.map(([, u]) => u)).toEqual(['blob:made-0', null, 'blob:made-0']);
    });

    it('drops its poster with the card, and when the embed changes to a host\'s picture', async () => {
      const { store, stage } = make();
      const el = embed({ media: { embed: { url: 'https://example.com/a' } } });
      store.add([el]);
      await vi.waitFor(() => expect(resolved()).toHaveLength(1));
      // Another page and a picture of the host's at once: the old tile has nothing left to stand in for.
      store.update(el.id, { media: { src: 'https://cdn.example/q.jpg', embed: { url: 'https://example.com/other' } } });
      expect(posterOf(store, el.id)).toBeUndefined();
      expect(stage.overrideCalls.at(-1)).toEqual([el.id, null]);
      // The card going away is the stage's to handle (it drops overrides with their element).
      store.remove([el.id]);
      await vi.waitFor(() => expect(resolved().length).toBeGreaterThan(0));
    });

    it('dispose revokes the blobs still waiting for their delayed revoke', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { store, layer } = make();
      const el = embed({ media: { embed: { url: 'https://example.com/a' } } });
      store.add([el]);
      await vi.waitFor(() => expect(resolved()).toHaveLength(1));
      store.remove([el.id]);
      expect(revoked).toEqual([]);
      layer.dispose();
      expect(revoked).toEqual(['blob:made-0']);
    });
  });

  it('refreshes the live frame when only the per-card resolution changes', () => {
    const { store, frames, tick } = make();
    const el = embed({ ...yt(), x: 0, y: 0, w: 480, h: 300 });
    store.add([el]);
    tick();
    const w = frames()[0].parentElement as HTMLElement;
    expect([w.style.width, w.style.height]).toEqual(['1152px', '720px']);
    const media = store.get(el.id)!.media;
    store.update(el.id, { media: { ...media, embed: { ...media.embed!, resolution: '1080p' } } });
    expect([w.style.width, w.style.height]).toEqual(['1728px', '1080px']);
  });

  it('keeps the live frame and interact mode when only the title changes', () => {
    const { store, layer, frames, tick } = make();
    const el = embed({ media: { embed: { ...yt().media.embed, title: 'Old' } } });
    store.add([el]);
    layer.setSelection([el.id]);
    tick();
    layer.onDblClick(el.id);
    const node = frames()[0];
    expect(layer.interacting).toBe(el.id);
    events.length = 0;
    const media = store.get(el.id)!.media;
    store.update(el.id, { media: { ...media, embed: { ...media.embed!, title: 'New' } } });
    tick();
    expect(frames()).toEqual([node]);
    expect(node.isConnected).toBe(true);
    expect(node.title).toBe('New');
    expect(layer.interacting).toBe(el.id);
    expect(layer.info(el.id)?.title).toBe('New');
    expect(events.filter(([t]) => t === 'embedLive' || t === 'embedInteract')).toEqual([]);
  });

  describe('a store batch that removes a card', () => {
    const settled = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

    it('does not track a card added and removed in the same batch', async () => {
      const resolve = vi.fn(() => null);
      const { store, layer, frames, tick } = make(1, { resolve });
      const el = embed({ media: { embed: { url: 'https://example.com/ghost' } } });
      store.batch(() => {
        store.add([el]);
        store.remove([el.id]);
      });
      await settled();
      tick();
      expect(layer.info(el.id)).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      expect(frames()).toHaveLength(0);
      expect(drawTile).not.toHaveBeenCalled();
    });

    it('does not bring back a card updated and removed in the same batch', async () => {
      const resolve = vi.fn(() => null);
      const { store, layer } = make(1, { resolve });
      const el = embed({ media: { embed: { url: 'https://example.com/first' } } });
      store.add([el]);
      await settled();
      resolve.mockClear();
      store.batch(() => {
        store.update(el.id, { media: { embed: { url: 'https://example.com/second' } } });
        store.remove([el.id]);
      });
      await settled();
      expect(layer.info(el.id)).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    });

    it('tracks only the latest state of a card added and updated in one batch', async () => {
      const resolve = vi.fn(() => null);
      const { store, layer } = make(1, { resolve });
      const el = embed({ media: { embed: { url: 'https://example.com/a' } } });
      store.batch(() => {
        store.add([el]);
        store.update(el.id, { media: { embed: { url: 'https://example.com/b' } } });
      });
      await settled();
      expect(layer.info(el.id)?.url).toBe('https://example.com/b');
      expect(resolve.mock.calls).toEqual([['https://example.com/b']]);
    });
  });

  it('keeps allow-same-origin on arbitrary pages unless arbitrarySameOrigin is false', () => {
    const page = () => embed({ media: { embed: { url: 'https://example.com/post' } } });
    const on = make();
    on.store.add([page()]);
    on.tick();
    expect(on.frames()[0].getAttribute('sandbox')).toContain('allow-same-origin');
    on.layer.dispose();

    document.body.innerHTML = '<div id="host" tabindex="0"><div id="root"></div></div>';
    host = document.getElementById('host') as HTMLElement;
    root = document.getElementById('root') as HTMLElement;
    const off = make(1, { arbitrarySameOrigin: false });
    off.store.add([page()]);
    off.tick();
    expect(off.frames()[0].getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
    // Switching it back at run time remounts the live frame with the new sandbox.
    off.layer.setOptions({ arbitrarySameOrigin: true });
    expect(off.frames()).toHaveLength(0);
    off.tick();
    expect(off.frames()[0].getAttribute('sandbox')).toContain('allow-same-origin');
  });

  it('autoplay: setOptions remounts YouTube and Vimeo with muted autoplay URLs, snippets and others untouched', () => {
    const { store, layer, frames, tick } = make();
    store.add([
      embed({ media: { embed: { url: 'https://youtu.be/aqz-KE-bpKQ' } } }),
      embed({ media: { embed: { url: 'https://vimeo.com/76979871' } } }),
      embed({ media: { embed: { html: '<b>hi</b>' } } }),
    ]);
    tick();
    const srcs = () => frames().map((f) => f.getAttribute('src'));
    expect(srcs().filter(Boolean)).toEqual([
      `https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?enablejsapi=1&origin=${encodeURIComponent(location.origin)}`,
      'https://player.vimeo.com/video/76979871',
    ]);
    layer.setOptions({ autoplay: true });
    // The two video frames were destroyed and come back with the new URL; the snippet stayed.
    expect(frames()).toHaveLength(1);
    tick();
    expect(frames()).toHaveLength(3);
    const byHost = (h: string) => frames().find((f) => f.getAttribute('src')?.includes(h)) as HTMLIFrameElement;
    const yt = byHost('youtube');
    const vimeo = byHost('vimeo');
    const q = (f: HTMLIFrameElement) => new URL(f.getAttribute('src') as string).searchParams;
    expect(q(yt).get('autoplay')).toBe('1');
    expect(q(yt).get('mute')).toBe('1');
    expect(q(yt).get('playlist')).toBe('aqz-KE-bpKQ');
    expect(q(vimeo).get('muted')).toBe('1');
    expect(frames().filter((f) => f.hasAttribute('srcdoc'))).toHaveLength(1);
    expect(yt.getAttribute('allow')).toContain('autoplay');
    // The resolved info keeps the plain URL.
    const [id] = [...store.elements()].map((e) => e.id);
    expect(layer.info(id)?.iframeSrc).toBe('https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ');
    // Off again: back to the plain URL.
    layer.setOptions({ autoplay: false });
    tick();
    const off = new URL(byHost('youtube').getAttribute('src') as string);
    expect(off.searchParams.get('enablejsapi')).toBe('1');
    expect(off.searchParams.has('autoplay')).toBe(false);
  });

  it('autoplay is an option at construction, and an infinite cap mounts every card in view', () => {
    const { store, frames, tick } = make(1, { autoplay: true, maxLive: Infinity, maxMounted: Infinity, maxLoading: Infinity });
    store.add(Array.from({ length: 40 }, () => embed({ media: { embed: { html: '<i>x</i>' } } })));
    store.add([embed({ media: { embed: { url: 'https://youtu.be/aqz-KE-bpKQ' } } })]);
    tick();
    expect(frames()).toHaveLength(41);
    expect(frames().at(-1)?.getAttribute('src')).toContain('autoplay=1');
  });

  describe('chunked loading', () => {
    const many = (n: number) => Array.from({ length: n }, () => embed({ media: { embed: { html: '<i>x</i>' } } }));

    it('mounts at most maxLoading frames at once, and the next chunk as they load', () => {
      const { store, layer, frames, tick } = make(1, { maxLive: Infinity, maxMounted: Infinity });
      store.add(many(20));
      tick();
      expect(frames()).toHaveLength(MAX_LOADING);
      expect(layer.loading.size).toBe(MAX_LOADING);
      for (const f of frames()) f.dispatchEvent(loadEvent());
      expect(layer.loading.size).toBe(0);
      tick();
      expect(frames()).toHaveLength(MAX_LOADING * 2);
    });

    it('frees the slot of a frame that never loads', () => {
      vi.useFakeTimers();
      const { store, frames, tick } = make(1, { maxLive: Infinity, maxMounted: Infinity, maxLoading: 2 });
      store.add(many(5));
      tick();
      expect(frames()).toHaveLength(2);
      vi.advanceTimersByTime(LOAD_SLOT_MS);
      tick();
      expect(frames()).toHaveLength(4);
    });

    it('never holds back the card in interact mode', () => {
      const { store, layer, frames, tick } = make(1, { maxLive: Infinity, maxMounted: Infinity, maxLoading: 1 });
      const els = many(3);
      store.add(els);
      tick();
      expect(frames()).toHaveLength(1);
      layer.setSelection([els[2].id]);
      expect(layer.interact(els[2].id)).toBe(true);
      expect(layer.live.has(els[2].id)).toBe(true);
    });
  });

  describe('culled frames', () => {
    // Four cards 500 apart, 480 wide, all in view at first. The view is 1600 x 1000, so the cull margin is
    // 400 px each side at scale 1: panning to tx -1000 takes card 0 out, to tx -1700 card 1 as well.
    const row = () => {
      const t = make(1, { maxLive: Infinity, maxMounted: Infinity, maxLoading: Infinity, cullMargin: 0.25 });
      const els = [0, 1, 2, 3].map((i) => embed({ media: { embed: { html: `<i>${i}</i>` } }, x: i * 500 }));
      t.store.add(els);
      t.tick();
      return { ...t, els };
    };
    // Mount order follows the distance from the centre, not the card order: find the card by its snippet.
    const wrapperOf = (i: number) =>
      [...root.querySelectorAll<HTMLElement>('.cb-embed')].find((w) =>
        w.querySelector('iframe')?.getAttribute('srcdoc')?.includes(`<i>${i}</i>`),
      ) as HTMLElement;

    it('hides a frame the moment it leaves the view, mid-pan, and shows it when it returns', () => {
      const { layer, cam, els } = row();
      expect(layer.live.size).toBe(4);
      expect(layer.culled.size).toBe(0);
      cam.tx = -1000; // view 1000..2600, with margin 600..3000: card 0 (0..480) is out
      layer.onFrame(true);
      expect(wrapperOf(0).dataset.culled).toBeDefined();
      expect(layer.culled).toEqual(new Set([els[0].id]));
      // Still mounted: nothing is destroyed while the camera moves.
      expect(layer.live.has(els[0].id)).toBe(true);
      cam.tx = 0;
      layer.onFrame(true);
      expect(wrapperOf(0).dataset.culled).toBeUndefined();
      expect(layer.culled.size).toBe(0);
    });

    it('only writes the attribute when it changes', () => {
      const { layer, cam } = row();
      cam.tx = -1000;
      layer.onFrame(true);
      const w = wrapperOf(0);
      const mo = new MutationObserver(() => {});
      mo.observe(w, { attributes: true, attributeFilter: ['data-culled'] });
      layer.onFrame(true);
      layer.onFrame(true);
      expect(mo.takeRecords()).toHaveLength(0);
      cam.tx = 0;
      layer.onFrame(true);
      expect(mo.takeRecords()).toHaveLength(1);
      mo.disconnect();
    });

    it('uses the bounding box of a rotated card', () => {
      const { store, layer, cam, tick } = make(1, { maxLive: Infinity, maxMounted: Infinity, maxLoading: Infinity });
      cam.tx = -2800; // view 2800..4400
      // Flat: x 2300..3700. Turned a quarter: it is upright around x 3000, x 2950..3050.
      const flat = embed({ media: { embed: { html: '<i>y</i>' } }, x: 2300, y: 450, w: 1400, h: 100 });
      const turned = embed({ media: { embed: { html: '<i>x</i>' } }, x: 2300, y: 450, w: 1400, h: 100, rot: 90 });
      store.add([flat, turned]);
      tick();
      expect(layer.live.size).toBe(2);
      cam.tx = -500; // view 500..2100, with margin 100..2500: flat reaches in, turned does not
      layer.onFrame(true);
      expect(layer.culled).toEqual(new Set([turned.id]));
    });

    it('keeps the card in interact mode visible', () => {
      const { layer, cam, els } = row();
      layer.setSelection([els[0].id]);
      expect(layer.interact(els[0].id)).toBe(true);
      cam.tx = -1000;
      layer.onFrame(true);
      expect(wrapperOf(0).dataset.culled).toBeUndefined();
    });

    it('on settle destroys the culled frames over maxOffscreen, least recently seen first', () => {
      const { store, layer, cam, frames, tick, els } = row();
      layer.setOptions({ maxOffscreen: 1 });
      // Pan right in two steps: card 0 leaves first, then card 1.
      cam.tx = -1000;
      layer.onFrame(true);
      cam.tx = -1700;
      layer.onFrame(true);
      expect(layer.culled).toEqual(new Set([els[0].id, els[1].id]));
      // Nothing is destroyed while moving.
      expect(layer.live.size).toBe(4);
      tick();
      expect(layer.live.has(els[0].id)).toBe(false);
      expect(layer.culled).toEqual(new Set([els[1].id]));
      expect(frames()).toHaveLength(3);
      expect(store.get(els[0].id)).toBeDefined();
    });

    it('keeps culled frames within budget on settle, and a returning card shows again', () => {
      const { layer, cam, tick, els } = row();
      cam.tx = -1000;
      layer.onFrame(true);
      tick();
      expect(layer.culled).toEqual(new Set([els[0].id]));
      expect(layer.live.has(els[0].id)).toBe(true);
      cam.tx = 0;
      layer.onFrame(true);
      tick();
      expect(layer.culled.size).toBe(0);
      expect(layer.parked.size).toBe(0);
    });

    it('re-mounts a destroyed card when it comes back, through the normal path', () => {
      const { layer, cam, tick, els, frames } = row();
      layer.setOptions({ maxOffscreen: 0 });
      cam.tx = -1000;
      layer.onFrame(true);
      tick();
      expect(layer.live.has(els[0].id)).toBe(false);
      cam.tx = 0;
      layer.onFrame(true);
      // Not while moving.
      expect(layer.live.has(els[0].id)).toBe(false);
      tick();
      expect(layer.live.has(els[0].id)).toBe(true);
      expect(layer.loading.has(els[0].id)).toBe(true);
      expect(frames().length).toBe(layer.live.size);
    });

    it('uses maxOffscreenTouch on touch', () => {
      const { layer } = make(1, { maxOffscreen: 9, maxOffscreenTouch: 2 });
      expect(layer.maxOffscreen).toBe(9);
      layer.setTouch(true);
      expect(layer.maxOffscreen).toBe(2);
      layer.setOptions({ maxOffscreenTouch: Infinity });
      expect(layer.maxOffscreen).toBe(Infinity);
    });
  });

  describe('freezing, pausing and snapshots', () => {
    const CB = 'corkboard-embed';
    const ALL = { maxLive: Infinity, maxMounted: Infinity, maxLoading: Infinity };
    let made = 0;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    beforeEach(() => {
      vi.useFakeTimers();
      made = 0;
      URL.createObjectURL = () => `blob:snap-${made++}`;
      URL.revokeObjectURL = () => {};
    });
    afterEach(() => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    });

    const snippet = (i = 0, init: Partial<ElementInit> = {}) =>
      embed({ media: { embed: { html: `<i>${i}</i>` } }, w: 480, h: 300, x: i * 500, ...init });
    // The iframe a snippet card mounted, found by its content, loaded, with a spy on what it is sent.
    const frameOf = (i: number) =>
      [...root.querySelectorAll<HTMLIFrameElement>('.cb-embed iframe')].find((f) => f.getAttribute('srcdoc')?.includes(`<i>${i}</i>`)) as HTMLIFrameElement;
    const spy = (f: HTMLIFrameElement) => vi.spyOn(f.contentWindow as Window, 'postMessage').mockImplementation(() => {});
    const load = (f: HTMLIFrameElement) => f.dispatchEvent(loadEvent());
    const ops = (p: ReturnType<typeof spy>, op: string) =>
      p.mock.calls.filter(([m]) => (m as { op?: string })?.op === op).map(([m]) => m as { id: number; w: number; h: number });
    const reply = (f: HTMLIFrameElement, data: unknown, source: unknown = f.contentWindow) =>
      window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
    const wrapperOf = (f: HTMLIFrameElement) => f.parentElement as HTMLElement;

    // One snippet card, loaded, shrunk to a 96 x 60 px card and settled: the snapshot request is out.
    const small = (opts: object = {}) => {
      const t = make(1, { ...ALL, ...opts });
      const el = snippet();
      t.store.add([el]);
      t.tick();
      const f = frameOf(0);
      load(f);
      const post = spy(f);
      t.cam.scale = 0.2;
      t.tick();
      return { ...t, el, f, post, w: wrapperOf(f) };
    };
    const SVG = '<svg><foreignObject/></svg>';
    const blob = () => new Blob(['img'], { type: 'image/webp' });
    // The frame answers with its markup and the layer draws it (the default test rasterizer resolves a blob).
    const answer = async (f: HTMLIFrameElement, id: number) => {
      reply(f, { cb: CB, op: 'snapshot', id, ok: true, svg: SVG });
      await vi.advanceTimersByTimeAsync(0);
    };
    // The poster texture lands, and the layer looks again.
    const land = () => vi.advanceTimersByTime(250);

    it('asks a small, settled snippet for a snapshot of its card\'s shape, and only once', () => {
      const { post, tick } = small();
      const [req] = ops(post, 'snapshot');
      expect(ops(post, 'snapshot')).toHaveLength(1);
      expect(req.w / req.h).toBeCloseTo(480 / 300, 1);
      expect(Math.max(req.w, req.h)).toBeLessThanOrEqual(640);
      // Sharp up to where it unfreezes (196 px short side), not just at today's zoom (60 px).
      expect(req.h).toBe(196);
      tick();
      tick();
      expect(ops(post, 'snapshot')).toHaveLength(1);
      expect(post.mock.calls.every((c) => (c as unknown[])[1] === '*')).toBe(true);
    });

    it('does not ask while the camera moves, for a big card, or when freezePx is 0', () => {
      const t = make(1, ALL);
      t.store.add([snippet()]);
      t.tick();
      const f = frameOf(0);
      load(f);
      const post = spy(f);
      t.cam.scale = 0.2;
      t.layer.onFrame(true);
      expect(ops(post, 'snapshot')).toHaveLength(0);
      t.cam.scale = 0.5; // 240 x 150: big enough
      t.layer.onSettle();
      expect(ops(post, 'snapshot')).toHaveLength(0);
      t.layer.setOptions({ freezePx: 0 });
      t.cam.scale = 0.2;
      t.tick();
      expect(ops(post, 'snapshot')).toHaveLength(0);
    });

    // What the bootstrap really sends: markup, drawn by the layer.
    const smallSvg = (rasterize: EmbedLayerDeps['rasterize']) => {
      const t = make(1, ALL, 4, { rasterize });
      const el = snippet();
      t.store.add([el]);
      t.tick();
      const f = frameOf(0);
      load(f);
      const post = spy(f);
      t.cam.scale = 0.2;
      t.tick();
      return { ...t, el, f, post, w: wrapperOf(f) };
    };

    it('draws the SVG a frame answers with, at the size it asked for, and freezes on it', async () => {
      const rasterize = vi.fn(async () => new Blob(['img'], { type: 'image/webp' }));
      const { store, el, f, post, w } = smallSvg(rasterize);
      const [req] = ops(post, 'snapshot');
      reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, svg: '<svg><foreignObject/></svg>' });
      expect(rasterize).toHaveBeenCalledWith('<svg><foreignObject/></svg>', req.w, req.h);
      await vi.advanceTimersByTimeAsync(0);
      expect(posterOf(store, el.id)).toBe('blob:snap-0');
      land();
      expect(w.dataset.frozen).toBeDefined();
    });

    it('tries a failed snapshot again later, a few times, then leaves the frame live', async () => {
      const rasterize = vi.fn(async () => null);
      const { f, post, w, tick } = smallSvg(rasterize);
      for (let i = 0; i < 3; i++) {
        const req = ops(post, 'snapshot').at(-1) as { id: number };
        expect(ops(post, 'snapshot')).toHaveLength(i + 1);
        reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, svg: '<svg/>' });
        await vi.advanceTimersByTimeAsync(0);
        vi.advanceTimersByTime(2000 * (i + 1));
        tick();
      }
      // Three tries in all.
      expect(ops(post, 'snapshot')).toHaveLength(3);
      expect(w.dataset.frozen).toBeUndefined();
    });

    it('shows the snapshot as the poster, then hides the frame once its texture shows', async () => {
      const { store, layer, el, f, post, w } = small();
      const [req] = ops(post, 'snapshot');
      await answer(f, req.id);
      expect(posterOf(store, el.id)).toBe('blob:snap-0');
      // Not before the poster shows: the frame covers the card until then.
      expect(w.dataset.frozen).toBeUndefined();
      land();
      expect(w.dataset.frozen).toBeDefined();
      expect(layer.frozen).toEqual(new Set([el.id]));
      // Frozen is still mounted, and keeps its budget slot; its document is told to stop.
      expect(layer.live.has(el.id)).toBe(true);
      expect(layer.parked.size).toBe(0);
      expect(ops(post, 'pause')).toHaveLength(1);
      expect(w.isConnected).toBe(true);
    });

    it('puts the snapshot over a picture of the host\'s without touching the store, and drops it again with the card', async () => {
      const t = make(1, ALL);
      const el = snippet(0, { media: { src: 'https://cdn.example/p.jpg', embed: { html: '<i>0</i>' } } });
      t.store.add([el]);
      t.tick();
      const f = frameOf(0);
      load(f);
      const post = spy(f);
      t.cam.scale = 0.2;
      t.tick();
      const changes: unknown[] = [];
      t.store.subscribe((e) => void changes.push(e));
      await answer(f, ops(post, 'snapshot')[0].id);
      // The real picture of the snippet wins over the host's poster; the host's own value stays in the store.
      expect(posterOf(t.store, el.id)).toBe('blob:snap-0');
      expect(t.store.get(el.id)?.media.src).toBe('https://cdn.example/p.jpg');
      expect(changes).toEqual([]);
    });

    it('waits while the poster has not landed, and leaves the frame live if it never does', async () => {
      const { layer, el, f, post, w } = small();
      unlanded.add(el.id);
      await answer(f, ops(post, 'snapshot')[0].id);
      vi.advanceTimersByTime(1000);
      expect(w.dataset.frozen).toBeUndefined();
      unlanded.delete(el.id);
      vi.advanceTimersByTime(150);
      expect(layer.frozen.has(el.id)).toBe(true);
    });

    it('leaves the frame live when the poster never lands', async () => {
      const { layer, el, f, post, w } = small();
      unlanded.add(el.id);
      await answer(f, ops(post, 'snapshot')[0].id);
      vi.advanceTimersByTime(10000);
      expect(layer.frozen.has(el.id)).toBe(false);
      expect(w.dataset.frozen).toBeUndefined();
    });

    it('ignores replies from another source or with another id', async () => {
      const { store, el, f, post, w, tick } = small();
      const [req] = ops(post, 'snapshot');
      const other = make(1, ALL);
      other.store.add([snippet(1)]);
      other.tick();
      const stranger = frameOf(1);
      const svg = (id: number, cb = CB) => ({ cb, op: 'snapshot', id, ok: true, svg: SVG });
      reply(f, svg(req.id), stranger.contentWindow);
      reply(f, svg(req.id), window);
      reply(f, svg(req.id + 1));
      reply(f, svg(req.id, 'other'));
      await vi.advanceTimersByTimeAsync(0);
      expect(posterOf(store, el.id)).toBeUndefined();
      land();
      expect(w.dataset.frozen).toBeUndefined();
      // The real reply still works afterwards.
      await answer(f, req.id);
      expect(posterOf(store, el.id)).toBe('blob:snap-0');
      tick();
    });

    it('leaves the frame live when the snapshot fails, and does not try again until it was big once more', () => {
      const { layer, cam, el, f, post, w, tick } = small();
      reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[0].id, ok: false });
      land();
      tick();
      expect(layer.frozen.size).toBe(0);
      expect(w.dataset.frozen).toBeUndefined();
      expect(ops(post, 'snapshot')).toHaveLength(1);
      expect(layer.live.has(el.id)).toBe(true);
      cam.scale = 1;
      tick();
      cam.scale = 0.2;
      tick();
      expect(ops(post, 'snapshot')).toHaveLength(2);
    });

    it('counts a reply without markup as a failure, and no longer takes a picture drawn by the frame', () => {
      const { layer, f, post, w, tick } = small();
      reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[0].id, ok: true, blob: blob() });
      land();
      tick();
      expect(layer.frozen.size).toBe(0);
      expect(w.dataset.frozen).toBeUndefined();
      expect(ops(post, 'snapshot')).toHaveLength(1);
    });

    it('gives up on a frame that never answers', () => {
      const { layer, post, tick } = small();
      vi.advanceTimersByTime(3000);
      tick();
      expect(ops(post, 'snapshot')).toHaveLength(1);
      expect(layer.frozen.size).toBe(0);
    });

    it('asks for at most MAX_SNAPSHOTS at a time, the next as one ends', () => {
      const t = make(1, ALL);
      const n = MAX_SNAPSHOTS + 1;
      const ids = Array.from({ length: n }, (_, i) => i);
      // Four to a row, so all of them are in the view.
      t.store.add(ids.map((i) => snippet(i, { x: (i % 4) * 500, y: Math.floor(i / 4) * 350 })));
      t.tick();
      const posts = ids.map((i) => {
        const f = frameOf(i);
        load(f);
        return spy(f);
      });
      t.cam.scale = 0.2;
      t.tick();
      const asked = () => posts.map((p) => ops(p, 'snapshot').length);
      expect(asked().reduce((a, b) => a + b)).toBe(MAX_SNAPSHOTS);
      const first = posts.findIndex((p) => ops(p, 'snapshot').length > 0);
      reply(frameOf(first), { cb: CB, op: 'snapshot', id: ops(posts[first], 'snapshot')[0].id, ok: false });
      t.tick();
      expect(asked().reduce((a, b) => a + b)).toBe(n);
    });

    it('shows the frame again at once when the card grows past 1.4x, not before', async () => {
      const { layer, cam, el, f, post, w, tick } = small();
      await answer(f, ops(post, 'snapshot')[0].id);
      land();
      expect(layer.frozen.has(el.id)).toBe(true);
      cam.scale = 0.5; // 150 px: over 140, under 196
      layer.onFrame(true);
      expect(w.dataset.frozen).toBeDefined();
      cam.scale = 0.7; // 210 px
      layer.onFrame(true); // mid-gesture is enough: no settle needed
      expect(w.dataset.frozen).toBeUndefined();
      expect(layer.frozen.size).toBe(0);
      expect(ops(post, 'resume')).toHaveLength(1);
      // The snapshot stays as the poster, and a frame that shrinks again is frozen again.
      cam.scale = 0.2;
      tick();
      expect(ops(post, 'snapshot')).toHaveLength(2);
    });

    it('shows the frame when its card is selected or enters interact mode', async () => {
      const { layer, cam, el, f, post, w, tick } = small();
      await answer(f, ops(post, 'snapshot')[0].id);
      land();
      expect(layer.frozen.has(el.id)).toBe(true);
      layer.setSelection([el.id]);
      layer.onFrame(false);
      expect(w.dataset.frozen).toBeUndefined();
      layer.setSelection([]);
      tick();
      expect(ops(post, 'snapshot')).toHaveLength(2);
      await answer(f, ops(post, 'snapshot')[1].id);
      land();
      expect(layer.frozen.has(el.id)).toBe(true);
      cam.scale = 0.3; // still small, over the minimum zoom to interact
      layer.setSelection([el.id]);
      expect(layer.interact(el.id)).toBe(true);
      expect(w.dataset.frozen).toBeUndefined();
      expect(layer.interacting).toBe(el.id);
      expect(ops(post, 'resume')).toHaveLength(2);
    });

    it('drops an answer that arrives after the card grew, and one for a destroyed frame', async () => {
      const { store, cam, el, f, post, w, tick } = small();
      const [req] = ops(post, 'snapshot');
      cam.scale = 1;
      tick();
      await answer(f, req.id);
      land();
      expect(posterOf(store, el.id)).toBeUndefined();
      expect(w.dataset.frozen).toBeUndefined();
    });

    it('never reports a snapshot blob as the persistable poster', async () => {
      const t = small();
      await answer(t.f, ops(t.post, 'snapshot')[0].id);
      await Promise.resolve();
      expect(posterOf(t.store, t.el.id)).toBe('blob:snap-0');
      expect(events.filter(([type]) => type === 'embedResolved').every(([, p]) => (p as { poster?: string }).poster === undefined)).toBe(true);
    });

    it('keeps its snapshot when the theme changes (a tile would replace the last frame)', async () => {
      const { layer, store, el, f, post } = small();
      await answer(f, ops(post, 'snapshot')[0].id);
      drawTile.mockClear();
      layer.setTheme();
      expect(drawTile).not.toHaveBeenCalled();
      expect(posterOf(store, el.id)).toBe('blob:snap-0');
    });

    it('asks once per freeze: the frame stays busy until the picture it sent is drawn and applied', async () => {
      let drawn!: (b: Blob | null) => void;
      const rasterize = vi.fn(() => new Promise<Blob | null>((r) => (drawn = r)));
      const { layer, store, el, f, post, w, tick } = smallSvg(rasterize);
      const [req] = ops(post, 'snapshot');
      reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, svg: SVG });
      expect(rasterize).toHaveBeenCalledTimes(1);
      // The slot is free for the others, but plans keep coming while the picture is drawn: this frame is not asked again.
      for (let i = 0; i < 4; i++) {
        tick();
        layer.setSelection([]);
        vi.advanceTimersByTime(500);
      }
      expect(ops(post, 'snapshot')).toHaveLength(1);
      expect(posterOf(store, el.id)).toBeUndefined();
      drawn(blob());
      await vi.advanceTimersByTimeAsync(0);
      expect(posterOf(store, el.id)).toBe('blob:snap-0');
      tick();
      expect(ops(post, 'snapshot')).toHaveLength(1);
      land();
      expect(w.dataset.frozen).toBeDefined();
      tick();
      vi.advanceTimersByTime(5000);
      // One freeze, one snapshot, one texture swap.
      expect(ops(post, 'snapshot')).toHaveLength(1);
      expect(made).toBe(1);
    });

    it('frees the snapshot slot at the reply, while the picture is still being drawn', () => {
      const t = make(1, ALL, 4, { rasterize: () => new Promise<Blob | null>(() => {}) });
      const n = MAX_SNAPSHOTS + 1;
      t.store.add(Array.from({ length: n }, (_, i) => snippet(i, { x: (i % 4) * 500, y: Math.floor(i / 4) * 350 })));
      t.tick();
      const posts = Array.from({ length: n }, (_, i) => {
        load(frameOf(i));
        return spy(frameOf(i));
      });
      t.cam.scale = 0.2;
      t.tick();
      const asked = () => posts.reduce((a, p) => a + ops(p, 'snapshot').length, 0);
      expect(asked()).toBe(MAX_SNAPSHOTS);
      const first = posts.findIndex((p) => ops(p, 'snapshot').length > 0);
      reply(frameOf(first), { cb: CB, op: 'snapshot', id: ops(posts[first], 'snapshot')[0].id, ok: true, svg: SVG });
      t.tick();
      // The one left over asks; the one that replied does not ask again.
      expect(asked()).toBe(n);
      expect(ops(posts[first], 'snapshot')).toHaveLength(1);
    });

    describe('a frame that loads again', () => {
      it('is sent its pause again: the new document knows nothing of the old one', () => {
        const t = make(1, { ...ALL, freezePx: 0 });
        t.store.add([snippet(0), snippet(1)]);
        t.tick();
        const fs = [frameOf(0), frameOf(1)];
        const posts = fs.map(spy);
        fs.forEach(load);
        t.layer.setOptions({ maxLive: 1 });
        t.tick();
        const i = fs.findIndex((f) => wrapperOf(f).dataset.parked !== undefined);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(ops(posts[i], 'pause')).toHaveLength(1);
        // The snippet reloads itself.
        load(fs[i]);
        expect(ops(posts[i], 'pause')).toHaveLength(2);
        expect(ops(posts[1 - i], 'pause')).toHaveLength(0);
        // A frame that was running is not told anything it did not need to hear.
        load(fs[1 - i]);
        expect(posts[1 - i].mock.calls).toEqual([]);
        // And a resume goes out as usual afterwards.
        t.layer.setOptions({ maxLive: 2 });
        t.tick();
        expect(ops(posts[i], 'resume')).toHaveLength(1);
      });

      it('drops the snapshot of the old document and asks the new one', () => {
        const { store, el, f, post, w, tick } = small();
        const [req] = ops(post, 'snapshot');
        load(f);
        // The reply of the old document is not a picture of the new one.
        reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, svg: SVG });
        expect(posterOf(store, el.id)).toBeUndefined();
        tick();
        const asked = ops(post, 'snapshot');
        expect(asked).toHaveLength(2);
        expect(asked[1].id).not.toBe(req.id);
        expect(w.dataset.frozen).toBeUndefined();
      });

      it('keeps a frozen frame frozen, and pauses the new document', async () => {
        const { layer, el, f, post, w, tick } = small();
        await answer(f, ops(post, 'snapshot')[0].id);
        land();
        expect(layer.frozen.has(el.id)).toBe(true);
        expect(ops(post, 'pause')).toHaveLength(1);
        load(f);
        tick();
        expect(layer.frozen.has(el.id)).toBe(true);
        expect(w.dataset.frozen).toBeDefined();
        expect(ops(post, 'pause')).toHaveLength(2);
        // Its picture is still the poster: nothing is asked.
        expect(ops(post, 'snapshot')).toHaveLength(1);
      });

      it('forgets that the last snapshot failed: the new document gets its tries', () => {
        const { f, post, tick } = small();
        reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[0].id, ok: false });
        tick();
        expect(ops(post, 'snapshot')).toHaveLength(1);
        load(f);
        tick();
        expect(ops(post, 'snapshot')).toHaveLength(2);
      });

      it('does not leak the timer of a video player\'s first load', () => {
        const t = make(1, { ...ALL, autoplay: true });
        t.store.add([embed({ media: { embed: { url: 'https://youtu.be/aqz-KE-bpKQ' } }, w: 480, h: 270 })]);
        t.cam.scale = 0.2;
        t.tick();
        const f = t.frames()[0];
        const post = spy(f);
        const funcs = () => post.mock.calls.map(([m]) => (JSON.parse(m as string) as { func: string }).func);
        load(f);
        const timers = vi.getTimerCount();
        load(f);
        expect(vi.getTimerCount()).toBe(timers);
        expect(funcs()).toEqual(['pauseVideo', 'pauseVideo']);
        vi.advanceTimersByTime(2000);
        // One resend, not one per load.
        expect(funcs()).toEqual(['pauseVideo', 'pauseVideo', 'pauseVideo']);
      });
    });

    describe('leaving and returning the view', () => {
      const CULL = { ...ALL, cullMargin: 0.25 };
      type Ops = ReturnType<typeof ops>[number] & { vw?: number; vh?: number };
      // One loaded snippet card in view, with a spy on what its frame is sent.
      const one = (opts: object = {}, deps: Partial<EmbedLayerDeps> = {}) => {
        const t = make(1, { ...CULL, ...opts }, 4, deps);
        const el = snippet();
        t.store.add([el]);
        t.tick();
        const f = frameOf(0);
        load(f);
        const post = spy(f);
        return { ...t, el, f, post, w: wrapperOf(f) };
      };
      // The same with a loaded YouTube card.
      const video = () => {
        const t = make(1, { ...CULL });
        t.store.add([embed({ ...yt(), w: 480, h: 270 })]);
        t.tick();
        const f = t.frames()[0];
        load(f);
        return { ...t, f, w: wrapperOf(f) };
      };
      const AWAY = -2000;
      const asked = (post: ReturnType<typeof spy>) => ops(post, 'snapshot') as Ops[];
      const back = (t: { cam: { tx: number }; layer: EmbedLayer }) => {
        t.cam.tx = 0;
        t.layer.onFrame(true);
      };
      const away = (t: { cam: { tx: number }; layer: EmbedLayer }) => {
        t.cam.tx = AWAY;
        t.layer.onFrame(true);
      };

      describe('last frame as the poster', () => {
        it('sends no show and never marks a returning frame as revealing: the transparent wrapper needs neither', () => {
          const t = one();
          away(t);
          vi.advanceTimersByTime(CULL_SNAPSHOT_MS);
          back(t);
          expect(t.w.dataset.culled).toBeUndefined();
          expect(t.w.dataset.revealing).toBeUndefined();
          expect(ops(t.post, 'show')).toHaveLength(0);
        });

        describe('while the camera moves fast', () => {
          // A frame of a pan: 16 ms after the last one, the camera is at `tx`.
          const pan = (t: { cam: { tx: number }; layer: EmbedLayer }, tx: number, ms = 16) => {
            vi.advanceTimersByTime(ms);
            t.cam.tx = tx;
            t.layer.onFrame(true);
          };

          it('hides a frame that leaves at once, with no snapshot', () => {
            const t = one();
            pan(t, -1000); // 1000 px in 16 ms
            expect(t.w.dataset.culled).toBeDefined();
            expect(t.w.dataset.culling).toBeUndefined();
            expect(asked(t.post)).toHaveLength(0);
            // The snapshot throttle is untouched: the frame is asked the next time it leaves slowly.
            pan(t, 0, 2000);
            pan(t, -870, 2000);
            pan(t, -890);
            expect(t.w.dataset.culling).toBeDefined();
            expect(asked(t.post)).toHaveLength(1);
          });

          it('snapshots a frame that leaves slowly, even mid-pan', () => {
            const t = one();
            pan(t, -870, 2000); // still on screen
            expect(t.w.dataset.culled).toBeUndefined();
            pan(t, -890); // 20 px in 16 ms: 1.25 px/ms
            expect(t.w.dataset.culling).toBeDefined();
            expect(asked(t.post)).toHaveLength(1);
          });

          it('counts a zoom as movement', () => {
            const t = make(1, { ...CULL });
            t.store.add([snippet(0, { x: 1300 })]);
            t.tick();
            const f = frameOf(0);
            load(f);
            const post = spy(f);
            const w = wrapperOf(f);
            vi.advanceTimersByTime(16);
            t.cam.scale = 4; // the card is far off to the right now, the point at the centre has not moved
            t.layer.onFrame(true);
            expect(w.dataset.culled).toBeDefined();
            expect(asked(post)).toHaveLength(0);
          });

          it('keeps the last reading for frames in the same millisecond, and forgets it after a pause in drawing', () => {
            const t = one();
            pan(t, -300); // fast
            t.cam.tx = -1000;
            t.layer.onFrame(true); // same ms: no new reading, still fast
            expect(asked(t.post)).toHaveLength(0);
            expect(t.w.dataset.culled).toBeDefined();
            // Nothing drawn for a while: the next jump is not measured against a stale camera.
            pan(t, 0, 1000);
            pan(t, -1200, 1000);
            expect(t.w.dataset.culling).toBeDefined();
          });
        });

        it('draws the picture of a cull snapshot when the browser is idle, not in the frame that took the reply', async () => {
          const idle: Array<() => void> = [];
          const win = document.defaultView as unknown as { requestIdleCallback?: unknown };
          win.requestIdleCallback = (cb: () => void) => idle.push(cb);
          try {
            const rasterize = vi.fn(async () => blob());
            const t = one({}, { rasterize });
            away(t);
            reply(t.f, { cb: CB, op: 'snapshot', id: asked(t.post)[0].id, ok: true, svg: SVG });
            expect(t.w.dataset.culled).toBeDefined();
            await vi.advanceTimersByTimeAsync(5000);
            expect(rasterize).not.toHaveBeenCalled();
            expect(idle).toHaveLength(1);
            idle[0]();
            await vi.advanceTimersByTimeAsync(0);
            expect(rasterize).toHaveBeenCalledTimes(1);
            expect(posterOf(t.store, t.el.id)).toBe('blob:snap-0');
          } finally {
            delete win.requestIdleCallback;
          }
        });

        it('does not draw when the frame went away before the browser was idle', async () => {
          const idle: Array<() => void> = [];
          const win = document.defaultView as unknown as { requestIdleCallback?: unknown };
          win.requestIdleCallback = (cb: () => void) => idle.push(cb);
          try {
            const rasterize = vi.fn(async () => blob());
            const t = one({ maxOffscreen: 0 }, { rasterize });
            away(t);
            reply(t.f, { cb: CB, op: 'snapshot', id: asked(t.post)[0].id, ok: true, svg: SVG });
            t.layer.onSettle();
            expect(t.layer.live.has(t.el.id)).toBe(false);
            idle[0]();
            await vi.advanceTimersByTimeAsync(0);
            expect(rasterize).not.toHaveBeenCalled();
          } finally {
            delete win.requestIdleCallback;
          }
        });

        it('keeps the frame visible while it is snapshotted, then hides it when the reply is in', async () => {
          const t = one();
          away(t);
          expect(t.layer.culled.has(t.el.id)).toBe(true);
          expect(t.w.dataset.culling).toBeDefined();
          expect(t.w.dataset.culled).toBeUndefined();
          const [req] = asked(t.post);
          expect(asked(t.post)).toHaveLength(1);
          // The layout size, for a window that reports none.
          expect(req.vw).toBeGreaterThan(0);
          expect(req.vh).toBeGreaterThan(0);
          expect(req.w / req.h).toBeCloseTo(480 / 300, 1);
          await answer(t.f, req.id);
          expect(t.w.dataset.culling).toBeUndefined();
          expect(t.w.dataset.culled).toBeDefined();
          // The poster is the last frame, and the frame is not frozen.
          expect(posterOf(t.store, t.el.id)).toBe('blob:snap-0');
          expect(t.layer.frozen.size).toBe(0);
          expect(t.w.dataset.frozen).toBeUndefined();
          expect(t.layer.live.has(t.el.id)).toBe(true);
        });

        it('hides the frame as soon as the markup is in, and sets the poster once it is drawn', async () => {
          const rasterize = vi.fn(async () => new Blob(['img'], { type: 'image/webp' }));
          const t = one({}, { rasterize });
          away(t);
          const [req] = asked(t.post);
          reply(t.f, { cb: CB, op: 'snapshot', id: req.id, ok: true, svg: '<svg><foreignObject/></svg>' });
          expect(t.w.dataset.culled).toBeDefined();
          // The drawing waits for the browser to be idle: not in the frame that took the reply.
          expect(rasterize).not.toHaveBeenCalled();
          expect(posterOf(t.store, t.el.id)).toBeUndefined();
          await vi.advanceTimersByTimeAsync(0);
          expect(rasterize).toHaveBeenCalledWith('<svg><foreignObject/></svg>', req.w, req.h);
          expect(posterOf(t.store, t.el.id)).toBe('blob:snap-0');
          expect(t.layer.frozen.size).toBe(0);
        });

        it('hides the frame after CULL_SNAPSHOT_MS when it does not answer', async () => {
          const t = one();
          away(t);
          vi.advanceTimersByTime(CULL_SNAPSHOT_MS - 1);
          expect(t.w.dataset.culled).toBeUndefined();
          vi.advanceTimersByTime(1);
          expect(t.w.dataset.culled).toBeDefined();
          expect(t.w.dataset.culling).toBeUndefined();
          // A late answer still gives the poster.
          await answer(t.f, asked(t.post)[0].id);
          expect(posterOf(t.store, t.el.id)).toBe('blob:snap-0');
        });

        it('hides the frame at once when the snapshot fails, and does not retry or block freezing', () => {
          const t = one();
          away(t);
          reply(t.f, { cb: CB, op: 'snapshot', id: asked(t.post)[0].id, ok: false });
          expect(t.w.dataset.culled).toBeDefined();
          expect(posterOf(t.store, t.el.id)).toBeUndefined();
          vi.advanceTimersByTime(10000);
          expect(asked(t.post)).toHaveLength(1);
        });

        it('cancels the pending cull when the card returns first, and ignores the late reply', async () => {
          const t = one();
          away(t);
          const [req] = asked(t.post);
          back(t);
          expect(t.w.dataset.culling).toBeUndefined();
          expect(t.w.dataset.culled).toBeUndefined();
          await answer(t.f, req.id);
          vi.advanceTimersByTime(CULL_SNAPSHOT_MS * 2);
          expect(t.w.dataset.culled).toBeUndefined();
          expect(posterOf(t.store, t.el.id)).toBeUndefined();
          // It did not use up the throttle: the next time it leaves it is asked again.
          away(t);
          expect(asked(t.post)).toHaveLength(2);
        });

        it('does not snapshot a frame again within CULL_SNAPSHOT_MIN_MS', async () => {
          const t = one();
          away(t);
          await answer(t.f, asked(t.post)[0].id);
          back(t);
          vi.advanceTimersByTime(1000);
          away(t);
          // Hidden at once, as before there were snapshots.
          expect(t.w.dataset.culled).toBeDefined();
          expect(t.w.dataset.culling).toBeUndefined();
          expect(asked(t.post)).toHaveLength(1);
          back(t);
          vi.advanceTimersByTime(CULL_SNAPSHOT_MIN_MS);
          away(t);
          expect(t.w.dataset.culling).toBeDefined();
          expect(asked(t.post)).toHaveLength(2);
        });

        it('hides at once what has nothing to snapshot: a page, a frozen frame, a frame that never loaded', async () => {
          const v = video();
          away(v);
          expect(v.w.dataset.culled).toBeDefined();
          expect(v.w.dataset.culling).toBeUndefined();

          const fz = small();
          await answer(fz.f, ops(fz.post, 'snapshot')[0].id);
          land();
          expect(fz.w.dataset.frozen).toBeDefined();
          fz.cam.tx = AWAY;
          fz.layer.onFrame(true);
          expect(fz.w.dataset.culled).toBeDefined();
          expect(ops(fz.post, 'snapshot')).toHaveLength(1);

          const nl = make(1, CULL);
          nl.store.add([snippet()]);
          nl.tick();
          nl.cam.tx = AWAY;
          nl.layer.onFrame(true);
          expect(wrapperOf(frameOf(0)).dataset.culled).toBeDefined();
        });

        it('leaves the last slots to freezing', () => {
          const run = (smalls: number) => {
            root.replaceChildren();
            const t = make(1, CULL);
            const big = snippet(0, { x: 0 });
            const littles = Array.from({ length: smalls }, (_, i) => snippet(i + 1, { x: 1000 + i * 120, w: 100, h: 60 }));
            t.store.add([big, ...littles]);
            t.tick();
            for (let i = 0; i <= smalls; i++) load(frameOf(i));
            const posts = [0, ...littles.map((_, i) => i + 1)].map((i) => spy(frameOf(i)));
            t.tick();
            // Every small card is asking to be frozen and nobody answers.
            expect(posts.slice(1).every((p) => ops(p, 'snapshot').length === 1)).toBe(true);
            t.cam.tx = -1000;
            t.layer.onFrame(true);
            return { w: wrapperOf(frameOf(0)), asked: ops(posts[0], 'snapshot').length };
          };
          const free = run(MAX_SNAPSHOTS - 3);
          expect(free.asked).toBe(1);
          expect(free.w.dataset.culling).toBeDefined();
          const full = run(MAX_SNAPSHOTS - 2);
          expect(full.asked).toBe(0);
          expect(full.w.dataset.culled).toBeDefined();
        });

        it('still pauses the document the moment it leaves, and resumes it on return', () => {
          const t = one();
          away(t);
          expect(ops(t.post, 'pause')).toHaveLength(1);
          back(t);
          expect(ops(t.post, 'resume')).toHaveLength(1);
        });
      });
    });

    describe('snippet pause', () => {
      const two = () => {
        const t = make(1, { ...ALL, freezePx: 0 });
        t.store.add([snippet(0), snippet(1)]);
        t.tick();
        const fs = [frameOf(0), frameOf(1)];
        fs.forEach(load);
        const posts = fs.map(spy);
        return { ...t, fs, posts };
      };

      it('pauses a parked snippet and resumes it when it is active again, only on a change', () => {
        const { layer, tick, fs, posts } = two();
        layer.setOptions({ maxLive: 1 });
        tick();
        const parkedId = [...layer.parked][0];
        const i = fs.findIndex((f) => wrapperOf(f).dataset.parked !== undefined);
        const j = 1 - i;
        expect(parkedId).toBeDefined();
        expect(posts[i].mock.calls).toEqual([[{ cb: CB, op: 'pause' }, '*']]);
        expect(posts[j].mock.calls).toEqual([]);
        tick();
        tick();
        expect(ops(posts[i], 'pause')).toHaveLength(1);
        layer.setOptions({ maxLive: 2 });
        tick();
        expect(posts[i].mock.calls).toEqual([[{ cb: CB, op: 'pause' }, '*'], [{ cb: CB, op: 'resume' }, '*']]);
      });

      it('pauses a culled snippet the moment it leaves, mid-pan, and resumes it on return', () => {
        const { cam, layer, posts } = two();
        cam.tx = -1600 * 2; // both far off
        layer.onFrame(true);
        expect(layer.culled.size).toBe(2);
        expect(posts.map((p) => ops(p, 'pause').length)).toEqual([1, 1]);
        layer.onFrame(true);
        expect(posts.map((p) => ops(p, 'pause').length)).toEqual([1, 1]);
        cam.tx = 0;
        layer.onFrame(true);
        expect(posts.map((p) => ops(p, 'resume').length)).toEqual([1, 1]);
      });

      it('waits for the document to load, then sends the state it should be in', () => {
        const t = make(1, { ...ALL, freezePx: 0, maxLive: 1 });
        t.store.add([snippet(0), snippet(1)]);
        t.tick();
        t.layer.setOptions({ maxLive: 2 });
        t.tick();
        t.layer.setOptions({ maxLive: 1 });
        t.tick();
        const fs = [frameOf(0), frameOf(1)];
        const posts = fs.map(spy);
        expect(t.layer.parked.size).toBe(1);
        expect(posts.flatMap((p) => p.mock.calls)).toEqual([]);
        fs.forEach(load);
        expect(posts.flatMap((p) => ops(p, 'pause'))).toHaveLength(1);
      });
    });

    describe('video players', () => {
      const YT = 'https://www.youtube-nocookie.com';
      const video = (url: string, init: Partial<ElementInit> = {}) =>
        embed({ media: { embed: { url } }, w: 480, h: 270, ...init });
      const one = (url: string, opts: object = {}, init: Partial<ElementInit> = {}) => {
        const t = make(1, { ...ALL, ...opts });
        const el = video(url, init);
        t.store.add([el]);
        t.tick();
        const f = t.frames()[0];
        load(f);
        const post = spy(f);
        return { ...t, el, f, post };
      };
      const sent = (post: ReturnType<typeof spy>) => post.mock.calls.map(([m, o]) => [typeof m === 'string' ? (JSON.parse(m) as { func: string }).func : m, o]);

      it('pauses a small YouTube card and plays it again when it grows (autoplay on)', () => {
        const { cam, tick, post } = one('https://youtu.be/aqz-KE-bpKQ', { autoplay: true });
        cam.scale = 0.2;
        tick();
        expect(sent(post)).toEqual([['pauseVideo', YT]]);
        tick();
        expect(sent(post)).toHaveLength(1);
        cam.scale = 1;
        tick();
        expect(sent(post)).toEqual([['pauseVideo', YT], ['playVideo', YT]]);
        expect(JSON.parse(post.mock.calls[0][0] as string)).toEqual({ event: 'command', func: 'pauseVideo', args: [] });
      });

      it('pauses and plays a Vimeo card with its own message and origin', () => {
        const { cam, tick, post } = one('https://vimeo.com/76979871', { autoplay: true });
        cam.scale = 0.2;
        tick();
        cam.scale = 1;
        tick();
        expect(post.mock.calls).toEqual([
          [{ method: 'pause' }, 'https://player.vimeo.com'],
          [{ method: 'play' }, 'https://player.vimeo.com'],
        ]);
      });

      it('pauses a culled video the moment it leaves, and plays it when it returns', () => {
        const { cam, layer, post } = one('https://youtu.be/aqz-KE-bpKQ', { autoplay: true });
        cam.tx = -5000;
        layer.onFrame(true);
        expect(sent(post)).toEqual([['pauseVideo', YT]]);
        cam.tx = 0;
        layer.onFrame(true);
        expect(sent(post)).toEqual([['pauseVideo', YT], ['playVideo', YT]]);
      });

      it('pauses a video that lost its live slot and is parked, and plays it again with the slot', () => {
        const t = make(1, { ...ALL, autoplay: true });
        t.store.add([video('https://youtu.be/aqz-KE-bpKQ'), video('https://youtu.be/dQw4w9WgXcQ', { x: 500 })]);
        t.tick();
        const posts = t.frames().map((f) => {
          load(f);
          return spy(f);
        });
        t.layer.setOptions({ maxLive: 1 });
        t.tick();
        expect(t.layer.parked.size).toBe(1);
        expect(posts.map((p) => sent(p).length).sort()).toEqual([0, 1]);
        t.layer.setOptions({ maxLive: 2 });
        t.tick();
        expect(posts.map((p) => sent(p).length).sort()).toEqual([0, 2]);
      });

      it('does not touch a video nobody started (autoplay off) until it was in interact mode', () => {
        const { layer, cam, el, tick, post } = one('https://youtu.be/aqz-KE-bpKQ');
        cam.scale = 0.2;
        tick();
        expect(post.mock.calls).toEqual([]);
        cam.scale = 1;
        tick();
        layer.setSelection([el.id]);
        layer.interact(el.id);
        layer.exitInteract();
        layer.setSelection([]);
        cam.scale = 0.2;
        tick();
        expect(sent(post)).toEqual([['pauseVideo', YT]]);
        cam.scale = 1;
        tick();
        expect(sent(post)).toEqual([['pauseVideo', YT], ['playVideo', YT]]);
      });

      it('never pauses the card in interact mode or a selected one, however small', () => {
        const { layer, cam, el, tick, post } = one('https://youtu.be/aqz-KE-bpKQ', { autoplay: true });
        cam.scale = 0.3; // 144 x 81 px: small, and over the minimum zoom
        layer.setSelection([el.id]);
        tick();
        expect(layer.interact(el.id)).toBe(true);
        tick();
        expect(post.mock.calls).toEqual([]);
        layer.exitInteract();
        layer.setSelection([]);
        tick();
        expect(sent(post)).toEqual([['pauseVideo', YT]]);
      });

      it('does not pause on size when freezePx is 0, but still pauses a culled one', () => {
        const { layer, cam, tick, post } = one('https://youtu.be/aqz-KE-bpKQ', { autoplay: true, freezePx: 0 });
        cam.scale = 0.2;
        tick();
        expect(post.mock.calls).toEqual([]);
        cam.tx = -5000;
        layer.onFrame(true);
        expect(sent(post)).toEqual([['pauseVideo', YT]]);
      });

      it('sends a command again once the player has had time to start (the first can be lost)', () => {
        const t = make(1, { ...ALL, autoplay: true });
        t.store.add([video('https://youtu.be/aqz-KE-bpKQ')]);
        t.cam.scale = 0.2;
        t.tick();
        const f = t.frames()[0];
        const post = spy(f);
        load(f);
        expect(sent(post)).toEqual([['pauseVideo', YT]]);
        vi.advanceTimersByTime(2000);
        expect(sent(post)).toEqual([['pauseVideo', YT], ['pauseVideo', YT]]);
      });

      it('leaves other pages alone, small or not', () => {
        const { cam, tick, post } = one('https://example.com/post', { autoplay: true });
        cam.scale = 0.2;
        tick();
        expect(post.mock.calls).toEqual([]);
      });
    });
  });

  describe('animating budget', () => {
    const CB = 'corkboard-embed';
    const ALL = { maxLive: Infinity, maxMounted: Infinity, maxLoading: Infinity, freezePx: 0 };
    const YT = 'https://www.youtube-nocookie.com';
    // The frame scheduler the layer is given: nothing runs until a test steps it with its own timestamps.
    function fakeRaf() {
      let cb: ((t: number) => void) | null = null;
      let id = 0;
      let t = 0;
      let wstart = 0;
      const call = (step: number): void => {
        t += step;
        const f = cb;
        cb = null;
        f?.(t);
      };
      return {
        raf: (f: (t: number) => void) => {
          cb = f;
          return ++id;
        },
        caf: vi.fn(() => {
          cb = null;
        }),
        running: () => cb !== null,
        // The first frame after a start only begins a window.
        first: (step: number) => {
          call(step);
          wstart = t;
        },
        // Frames of `step` ms until a window of at least one second has ended. Like a real 60 Hz display under
        // load, a slow window still has a couple of frames one vsync apart: the layer reads the refresh from them.
        win: (step: number) => {
          for (let i = 0; i < 2 && cb !== null && step > 17; i++) call(1000 / 60);
          do call(step);
          while (cb !== null && t - wstart < 1000);
          wstart = t;
        },
        // A window of evenly spaced frames: what a display that refreshes every `step` ms shows when nothing is slow.
        steady: (step: number) => {
          do call(step);
          while (cb !== null && t - wstart < 1000);
          wstart = t;
        },
        jump: (ms: number) => {
          call(ms);
          wstart = t;
        },
      };
    }
    function build(opts: object = {}, scale = 1, burst: object = { burstWindows: Infinity, agreeWindows: Infinity }) {
      const clock = fakeRaf();
      const store = new Store();
      const { stage, cam } = fakeStage(store, scale);
      // Bursts are the monitor's own tests; here every window counts, so a test can walk the budget with them.
      const monitor = new FrameRateMonitor({ raf: clock.raf, caf: clock.caf, heartbeatMs: Infinity, ...burst });
      const layer = new EmbedLayer(
        { root, host, store, stage, emit: () => {}, frameRate: monitor, rasterize: async () => new Blob(['img']) },
        { ...ALL, ...opts },
      );
      made.push(layer);
      const tick = () => {
        layer.onFrame(false);
        layer.onSettle();
      };
      return { store, layer, cam, clock, tick, monitor };
    }
    const snippet = (i: number, init: Partial<ElementInit> = {}) =>
      embed({ media: { embed: { html: `<i>${i}</i>` } }, w: 480, h: 300, x: i * 500, ...init });
    const frameOf = (i: number) =>
      [...root.querySelectorAll<HTMLIFrameElement>('.cb-embed iframe')].find((f) => f.getAttribute('srcdoc')?.includes(`<i>${i}</i>`)) as HTMLIFrameElement;
    const load = (f: HTMLIFrameElement) => f.dispatchEvent(loadEvent());
    const spy = (f: HTMLIFrameElement) => vi.spyOn(f.contentWindow as Window, 'postMessage').mockImplementation(() => {});
    // What a frame was sent.
    const sentTo = (p: ReturnType<typeof spy>) => p.mock.calls;
    const ops = (p: ReturnType<typeof spy>, op: string) => p.mock.calls.filter(([m]) => (m as { op?: string })?.op === op).length;
    const ids = (els: { id: string }[]) => new Set(els.map((e) => e.id));

    // Three snippets of different size, in view: a small one near the centre, a big one in a corner, a medium one.
    const three = (opts: object = {}) => {
      const t = build(opts);
      const els = [
        snippet(0, { x: 700, y: 440, w: 200, h: 120 }),
        snippet(1, { x: 50, y: 50, w: 480, h: 300 }),
        snippet(2, { x: 1000, y: 600, w: 320, h: 200 }),
      ];
      t.store.add(els);
      t.tick();
      return { ...t, els };
    };

    describe('ranking', () => {
      it('is unconstrained by default', () => {
        const { layer, els } = three();
        expect(layer.animatingBudget).toBe(Infinity);
        expect(layer.animating).toEqual(ids(els));
      });

      it('gives the slots to the biggest on screen first', () => {
        const { layer, els, tick } = three({ maxAnimating: 1, adaptive: false });
        expect(layer.animatingBudget).toBe(1);
        expect(layer.animating).toEqual(ids([els[1]]));
        layer.setOptions({ maxAnimating: 2 });
        tick();
        expect(layer.animating).toEqual(ids([els[1], els[2]]));
      });

      it('counts only the part of a card that is in view', () => {
        const t = build({ maxAnimating: 1, adaptive: false });
        // The big card is mostly off screen to the right; the smaller one is fully in view.
        const els = [snippet(0, { x: 1500, y: 0, w: 900, h: 600 }), snippet(1, { x: 100, y: 100, w: 300, h: 200 })];
        t.store.add(els);
        t.tick();
        expect(t.layer.animating).toEqual(ids([els[1]]));
      });

      it('breaks a tie by the distance to the centre of the view', () => {
        const t = build({ maxAnimating: 1, adaptive: false });
        const els = [snippet(0, { x: 50, y: 50, w: 300, h: 200 }), snippet(1, { x: 650, y: 400, w: 300, h: 200 })];
        t.store.add(els);
        t.tick();
        expect(t.layer.animating).toEqual(ids([els[1]]));
      });

      it('ranks the selected card first, and re-ranks at once', () => {
        const { layer, els } = three({ maxAnimating: 1, adaptive: false });
        layer.setSelection([els[0].id]);
        expect(layer.animating).toEqual(ids([els[0]]));
        layer.setSelection([]);
        expect(layer.animating).toEqual(ids([els[1]]));
      });

      it('ranks the card in interact mode before the selected one', () => {
        const { layer, els } = three({ maxAnimating: 1, adaptive: false });
        layer.setSelection([els[2].id]);
        layer.interact(els[0].id);
        expect(layer.interacting).toBe(els[0].id);
        expect(layer.animating).toEqual(ids([els[0]]));
        layer.exitInteract();
        expect(layer.animating).toEqual(ids([els[2]]));
      });

      it('leaves out frames that are parked or culled', () => {
        const t = build({ adaptive: false });
        t.store.add([snippet(0), snippet(1), snippet(2)]);
        t.tick();
        t.layer.setOptions({ maxLive: 1 });
        t.tick();
        // Two are parked (out of the live budget): one frame is left to animate.
        expect(t.layer.parked.size).toBe(2);
        expect(t.layer.animating.size).toBe(1);
        t.cam.tx = -1600 * 20;
        t.layer.onFrame(true);
        t.layer.onSettle();
        expect(t.layer.culled.size).toBe(3);
        expect(t.layer.animating.size).toBe(0);
      });
    });

    describe('what is paused', () => {
      const three2 = (opts: object = {}) => {
        const t = three(opts);
        const fs = [0, 1, 2].map(frameOf);
        // Spies first: the state a frame should be in goes out when it has loaded.
        const posts = fs.map(spy);
        fs.forEach(load);
        return { ...t, fs, posts };
      };

      it('pauses the frames past the budget and resumes them, only on a change', () => {
        const { layer, tick, posts } = three2({ maxAnimating: 1, adaptive: false });
        // Cards: 0 small, 1 big, 2 medium. Only the big one has the slot; the others are told on load.
        expect(sentTo(posts[1])).toEqual([]);
        expect(sentTo(posts[0])).toEqual([[{ cb: CB, op: 'pause' }, '*']]);
        expect(sentTo(posts[2])).toEqual([[{ cb: CB, op: 'pause' }, '*']]);
        tick();
        tick();
        layer.setOptions({ maxAnimating: 1 });
        tick();
        expect(posts.map((p) => sentTo(p).length)).toEqual([1, 0, 1]);
        // The medium one is back inside; the small one stays paused.
        layer.setOptions({ maxAnimating: 2 });
        tick();
        expect(posts.map((p) => [ops(p, 'pause'), ops(p, 'resume')])).toEqual([[1, 0], [0, 0], [1, 1]]);
        layer.setOptions({ maxAnimating: 2 });
        tick();
        expect(posts.map((p) => sentTo(p).length)).toEqual([1, 0, 2]);
        layer.setOptions({ maxAnimating: Infinity });
        tick();
        expect(posts.map((p) => [ops(p, 'pause'), ops(p, 'resume')])).toEqual([[1, 1], [0, 0], [1, 1]]);
      });

      it('never pauses the card in interact mode, whatever its rank', () => {
        const { layer, els, posts } = three2({ maxAnimating: 1, adaptive: false });
        layer.interact(els[2].id);
        expect(layer.animating).toEqual(ids([els[2]]));
        // Paused when it loaded (it ranked last), resumed the moment it is in interact mode.
        expect([ops(posts[2], 'pause'), ops(posts[2], 'resume')]).toEqual([1, 1]);
        layer.exitInteract();
        expect([ops(posts[2], 'pause'), ops(posts[2], 'resume')]).toEqual([2, 1]);
      });
    });

    describe('frames that cannot be paused', () => {
      it('take no slot from the ones that can, and are never sent anything', () => {
        const t = build({ maxAnimating: 1, adaptive: false });
        const page = embed({ media: { embed: { url: 'https://example.com/post' } }, x: 50, y: 50, w: 900, h: 600 });
        const small = snippet(0, { x: 1100, y: 100, w: 200, h: 120 });
        const smaller = snippet(1, { x: 1100, y: 400, w: 100, h: 60 });
        t.store.add([page, small, smaller]);
        t.tick();
        const pageFrame = [...root.querySelectorAll<HTMLIFrameElement>('.cb-embed iframe')].find((f) => f.getAttribute('src')?.includes('example.com')) as HTMLIFrameElement;
        const fs = [pageFrame, frameOf(0), frameOf(1)];
        const posts = fs.map(spy);
        fs.forEach(load);
        expect(t.layer.animating).toEqual(ids([small]));
        expect(posts[0].mock.calls).toEqual([]);
        expect(ops(posts[1], 'pause')).toBe(0);
        expect(ops(posts[2], 'pause')).toBe(1);
      });

      it('pauses a video through its player, and a video nobody started takes no slot', () => {
        const t = build({ maxAnimating: 1, adaptive: false, autoplay: true });
        const small = snippet(0, { x: 1100, y: 100, w: 200, h: 120 });
        const video = embed({ media: { embed: { url: 'https://youtu.be/aqz-KE-bpKQ' } }, x: 50, y: 50, w: 480, h: 270 });
        const video2 = embed({ media: { embed: { url: 'https://youtu.be/dQw4w9WgXcQ' } }, x: 600, y: 50, w: 240, h: 135 });
        t.store.add([small, video, video2]);
        t.tick();
        const all = [...root.querySelectorAll<HTMLIFrameElement>('.cb-embed iframe')];
        const yts = ['aqz-KE-bpKQ', 'dQw4w9WgXcQ'].map((id) => all.find((f) => f.getAttribute('src')?.includes(id)) as HTMLIFrameElement);
        const posts = yts.map(spy);
        yts.forEach(load);
        // The big video has the slot; the small video and the snippet are paused.
        expect(t.layer.animating).toEqual(ids([video]));
        const sent = (p: ReturnType<typeof spy>) => p.mock.calls.map(([m, o]) => [(JSON.parse(m as string) as { func: string }).func, o]);
        expect(sent(posts[0])).toEqual([]);
        expect(sent(posts[1])).toEqual([['pauseVideo', YT]]);
        t.layer.setOptions({ maxAnimating: Infinity });
        t.tick();
        expect(sent(posts[1])).toEqual([['pauseVideo', YT], ['playVideo', YT]]);
        // Without autoplay and never interacted with, a player is not playing: it takes no slot.
        t.layer.setOptions({ autoplay: false, maxAnimating: 1 });
        t.tick();
        expect(t.layer.animating).toEqual(ids([small]));
      });
    });

    describe('adaptive sampler', () => {
      // 20 snippets in view at 0.2x: all mounted, all animating.
      const many = (opts: object = {}, scale = 0.2, burst?: object) => {
        const t = build(opts, scale, burst);
        const els = Array.from({ length: 20 }, (_, i) => snippet(i, { x: (i % 5) * 500, y: Math.floor(i / 5) * 320 }));
        t.store.add(els);
        t.tick();
        const fs = els.map((_, i) => frameOf(i));
        fs.forEach(load);
        const posts = fs.map(spy);
        const paused = () => posts.reduce((n, p) => n + ops(p, 'pause'), 0);
        const resumed = () => posts.reduce((n, p) => n + ops(p, 'resume'), 0);
        return { ...t, els, posts, paused, resumed };
      };

      it('starts when a visible frame renders, and ignores the first window', () => {
        const t = many();
        expect(t.clock.running()).toBe(true);
        t.clock.first(100);
        t.clock.win(100);
        expect(t.layer.animatingBudget).toBe(Infinity);
        expect(t.paused()).toBe(0);
        t.clock.win(100);
        expect(t.layer.animatingBudget).toBe(14);
      });

      it('lowers the budget on slow windows, never under MIN_ANIMATING, and recovers after 2 smooth ones', () => {
        const t = many();
        t.clock.first(100);
        t.clock.win(100); // ignored
        const seen: number[] = [];
        for (let i = 0; i < 4; i++) {
          t.clock.win(100);
          seen.push(t.layer.animatingBudget);
        }
        // floor(20 x 0.7), then 70% of what animates, down to the floor.
        expect(seen).toEqual([14, 9, 6, 6]);
        expect(t.layer.animating.size).toBe(6);
        expect(t.paused()).toBe(14);
        expect(t.resumed()).toBe(0);
        const up: number[] = [];
        for (let i = 0; i < 8; i++) {
          t.clock.win(16);
          up.push(t.layer.animatingBudget);
        }
        // Nothing on the first smooth window; ceil(N x 1.25) + 2 on the second; unconstrained once N covers everything.
        expect(up).toEqual([6, 10, 10, 15, 15, Infinity, Infinity, Infinity]);
        expect(t.layer.animating.size).toBe(20);
        expect(t.resumed()).toBe(14);
        expect(t.paused()).toBe(14);
      });

      it('judges a 30 Hz display against its own rate, not as a slow page', () => {
        const t = many();
        t.clock.first(1000 / 30);
        for (let i = 0; i < 4; i++) t.clock.steady(1000 / 30);
        expect(t.layer.animatingBudget).toBe(Infinity);
        expect(t.paused()).toBe(0);
        // Half its rate on that display is slow.
        t.clock.steady(1000 / 12);
        expect(t.layer.animatingBudget).toBe(14);
      });

      it('does not count a window in between as smooth', () => {
        const t = many();
        t.clock.first(100);
        t.clock.win(100);
        t.clock.win(100);
        expect(t.layer.animatingBudget).toBe(14);
        t.clock.win(16);
        t.clock.win(22); // ~45 fps: neither slow nor smooth
        t.clock.win(16);
        expect(t.layer.animatingBudget).toBe(14);
        t.clock.win(16);
        // ceil(14 x 1.25) + 2 = 20 covers all 20 frames.
        expect(t.layer.animatingBudget).toBe(Infinity);
      });

      it('drops the window that follows a stall (a hidden page), then measures again', () => {
        const t = many();
        t.clock.first(16);
        t.clock.win(16);
        t.clock.jump(10000);
        t.clock.win(100); // ignored
        expect(t.layer.animatingBudget).toBe(Infinity);
        t.clock.win(100);
        expect(t.layer.animatingBudget).toBe(14);
      });

      it('never goes past maxAnimating', () => {
        const t = many({ maxAnimating: 8 });
        expect(t.layer.animatingBudget).toBe(8);
        t.clock.first(100);
        t.clock.win(100);
        t.clock.win(100);
        // 70% of the 8 that animate is 5: under the floor of 6, which is under the ceiling.
        expect(t.layer.animatingBudget).toBe(6);
        t.clock.win(16);
        t.clock.win(16);
        // ceil(6 x 1.25) + 2 = 10 is past the ceiling: back to it, and no further.
        expect(t.layer.animatingBudget).toBe(8);
        t.clock.win(16);
        t.clock.win(16);
        expect(t.layer.animatingBudget).toBe(8);
        expect(t.layer.animating.size).toBe(8);
      });

      describe('freeze size', () => {
        // 20 snippets 480 x 300 at 0.5x: 150 px on the short side, over freezePx (140) and under 1.5x it.
        const frozen20 = (opts: object = {}) => {
          const t = many({ freezePx: 140, ...opts }, 0.5);
          t.clock.first(100);
          t.clock.win(100); // ignored
          const reqs = (p: ReturnType<typeof spy>) =>
            p.mock.calls.map(([m]) => m as { op?: string; id: number; h: number }).filter((m) => m.op === 'snapshot');
          const snaps = () => t.posts.reduce((n, p) => n + reqs(p).length, 0);
          return { ...t, snaps, reqs };
        };
        const slow = (t: ReturnType<typeof frozen20>, n: number) => {
          const seen: number[] = [];
          for (let i = 0; i < n; i++) {
            t.clock.win(100);
            seen.push(t.layer.freezeThreshold);
          }
          return seen;
        };

        it('starts at freezePx and leaves it alone until the budget is at its floor', () => {
          const t = frozen20();
          expect(t.layer.freezeThreshold).toBe(140);
          // Budgets 14, 9, 6: the window that reaches the floor does not raise it yet.
          expect(slow(t, 3)).toEqual([140, 140, 140]);
          expect(t.layer.animatingBudget).toBe(6);
          expect(t.snaps()).toBe(0);
        });

        it('multiplies by 1.5 per slow window at the floor, up to 4x, and freezes what is then small', () => {
          const t = frozen20();
          slow(t, 3);
          expect(slow(t, 5)).toEqual([210, 315, 472.5, 560, 560]);
          t.tick();
          // 150 px cards are small now: asked for a snapshot, at the size they reach before they thaw.
          expect(t.snaps()).toBeGreaterThan(0);
          // Sharp up to where they thaw: 1.4 x 560 px on the short side (device px, dpr 1), 640 on the long one.
          const [req] = t.posts.flatMap((p) => t.reqs(p));
          expect(req.h).toBe(400);
        });

        it('lowers it by 1.5 per pair of smooth windows, down to freezePx', () => {
          const t = frozen20();
          slow(t, 6); // 140 -> 210 -> 315 -> 472.5
          expect(t.layer.freezeThreshold).toBe(472.5);
          const down: number[] = [];
          for (let i = 0; i < 8; i++) {
            t.clock.win(16);
            down.push(t.layer.freezeThreshold);
          }
          expect(down).toEqual([472.5, 315, 315, 210, 210, 140, 140, 140]);
        });

        it('does not count a window in between as smooth, and a slow one starts the pair over', () => {
          const t = frozen20();
          slow(t, 4); // 210
          t.clock.win(16);
          t.clock.win(22); // ~45 fps
          t.clock.win(16);
          expect(t.layer.freezeThreshold).toBe(210);
          t.clock.win(16);
          expect(t.layer.freezeThreshold).toBe(140);
        });

        it('never moves with freezePx 0, and goes back to freezePx when adaptive is turned off', () => {
          const off = frozen20({ freezePx: 0 });
          slow(off, 6);
          expect(off.layer.freezeThreshold).toBe(0);
          const t = frozen20();
          slow(t, 5);
          expect(t.layer.freezeThreshold).toBeGreaterThan(140);
          t.layer.setOptions({ adaptive: false });
          expect(t.layer.freezeThreshold).toBe(140);
        });

        it('thaws what is no longer small once it is lowered, with the usual hysteresis', async () => {
          const t = frozen20();
          slow(t, 4); // 210: the 150 px cards are small
          t.tick();
          // The six that were asked (MAX_SNAPSHOTS) are small now; one of them answers.
          const i = t.posts.findIndex((p) => t.reqs(p).length > 0);
          expect(i).toBeGreaterThanOrEqual(0);
          const f = frameOf(i);
          const [first] = t.reqs(t.posts[i]);
          window.dispatchEvent(new MessageEvent('message', { data: { cb: CB, op: 'snapshot', id: first.id, ok: true, svg: '<svg/>' }, source: f.contentWindow as Window }));
          await new Promise((r) => setTimeout(r, 300));
          expect(t.layer.frozen.has(t.els[i].id)).toBe(true);
          for (let i = 0; i < 4; i++) t.clock.win(16);
          t.tick();
          // 150 px is under 1.4 x 140 = 196: still frozen. Only a bigger card thaws.
          expect(t.layer.freezeThreshold).toBe(140);
          expect(t.layer.frozen.has(t.els[i].id)).toBe(true);
          t.cam.scale = 0.7;
          t.layer.onFrame(true);
          expect(t.layer.frozen.has(t.els[i].id)).toBe(false);
        });
      });

      describe('in bursts', () => {
        const bursts = { burstWindows: 4, agreeWindows: 2 };

        it('stops measuring once the readings agree, so the page can idle', () => {
          const t = many({}, 0.2, bursts);
          expect(t.clock.running()).toBe(true);
          t.clock.first(16);
          t.clock.win(16); // dropped
          t.clock.win(16);
          t.clock.win(16);
          expect(t.layer.animatingBudget).toBe(Infinity);
          expect(t.clock.running()).toBe(false);
        });

        it('keeps going while its own budget changes, and stops when the floor is reached', () => {
          const t = many({}, 0.2, bursts);
          t.clock.first(100);
          t.clock.win(100); // dropped
          const seen: number[] = [];
          for (let i = 0; i < 6 && t.clock.running(); i++) {
            t.clock.win(100);
            seen.push(t.layer.animatingBudget);
          }
          // Each window lowered the budget, which asked for another one; the last two agree at the floor.
          expect(seen).toEqual([14, 9, 6, 6, 6]);
          expect(t.clock.running()).toBe(false);
          expect(t.paused()).toBe(14);
        });

        it('measures again when frames are mounted or destroyed', () => {
          const t = many({}, 0.2, bursts);
          t.clock.first(16);
          t.clock.win(16);
          t.clock.win(16);
          t.clock.win(16);
          expect(t.clock.running()).toBe(false);
          t.store.remove([t.els[0].id]);
          t.tick();
          expect(t.clock.running()).toBe(true);
        });

        it('measures again when the camera settles with frames still rendering, not when nothing renders', () => {
          const t = many({}, 0.2, bursts);
          t.clock.first(16);
          t.clock.win(16);
          t.clock.win(16);
          t.clock.win(16);
          expect(t.clock.running()).toBe(false);
          // The board pokes its monitor on a settled camera.
          t.monitor.poke();
          expect(t.clock.running()).toBe(true);
          t.cam.tx = -1600 * 20;
          t.layer.onFrame(true);
          t.layer.onSettle();
          expect(t.layer.culled.size).toBe(20);
          expect(t.clock.running()).toBe(false);
          t.monitor.poke();
          expect(t.clock.running()).toBe(false);
        });

        it('measures again when the budget ceiling or the switch is changed by the host', () => {
          const t = many({}, 0.2, bursts);
          t.clock.first(16);
          t.clock.win(16);
          t.clock.win(16);
          t.clock.win(16);
          expect(t.clock.running()).toBe(false);
          t.layer.setOptions({ maxAnimating: 10 });
          expect(t.clock.running()).toBe(true);
        });
      });

      it('adaptive: false restores the ceiling and stops the sampler', () => {
        const t = many({ maxAnimating: 12 });
        t.clock.first(100);
        t.clock.win(100);
        t.clock.win(100);
        expect(t.layer.animatingBudget).toBe(8);
        t.layer.setOptions({ adaptive: false });
        expect(t.layer.animatingBudget).toBe(12);
        expect(t.layer.animating.size).toBe(12);
        expect(t.clock.running()).toBe(false);
        expect(t.clock.caf).toHaveBeenCalled();
        t.tick();
        expect(t.clock.running()).toBe(false);
        t.layer.setOptions({ adaptive: true });
        expect(t.clock.running()).toBe(true);
        expect(t.layer.animatingBudget).toBe(12);
      });

      it('is not started when adaptive is off from the start', () => {
        const t = many({ adaptive: false });
        expect(t.clock.running()).toBe(false);
      });

      it('stops when nothing is visible, and starts again when something is', () => {
        const t = many();
        expect(t.clock.running()).toBe(true);
        t.cam.tx = -1600 * 20;
        t.layer.onFrame(true);
        t.layer.onSettle();
        expect(t.layer.culled.size).toBe(20);
        expect(t.clock.running()).toBe(false);
        t.cam.tx = 0;
        t.tick();
        expect(t.clock.running()).toBe(true);
      });

      it('stops while the tab is hidden, and measures from scratch when it is back', () => {
        const t = many();
        let state = 'visible';
        const get = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state as DocumentVisibilityState);
        try {
          t.clock.first(100);
          t.clock.win(100);
          state = 'hidden';
          document.dispatchEvent(new Event('visibilitychange'));
          expect(t.clock.running()).toBe(false);
          state = 'visible';
          document.dispatchEvent(new Event('visibilitychange'));
          expect(t.clock.running()).toBe(true);
          t.clock.first(100);
          t.clock.win(100); // the first window again: ignored
          expect(t.layer.animatingBudget).toBe(Infinity);
          t.clock.win(100);
          expect(t.layer.animatingBudget).toBe(14);
        } finally {
          get.mockRestore();
        }
      });

      it('stops when its last frame is destroyed', () => {
        const t = many();
        t.store.remove(t.els.map((e) => e.id));
        t.tick();
        expect(t.layer.live.size).toBe(0);
        expect(t.clock.running()).toBe(false);
      });

      it('stops on dispose', () => {
        const t = many();
        expect(t.clock.running()).toBe(true);
        t.layer.dispose();
        expect(t.clock.running()).toBe(false);
        expect(t.clock.caf).toHaveBeenCalled();
      });
    });
  });

  describe('snippet previews', () => {
    const CB = 'corkboard-embed';
    const NONE = { maxLive: 0, maxMounted: 0 };
    let made = 0;
    const revoked: string[] = [];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    beforeEach(() => {
      vi.useFakeTimers();
      made = 0;
      revoked.length = 0;
      URL.createObjectURL = () => `blob:pv-${made++}`;
      URL.revokeObjectURL = (u: string) => void revoked.push(u);
    });
    afterEach(() => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    });

    const snip = (i: number, init: Partial<ElementInit> = {}) =>
      embed({ media: { embed: { html: `<i>${i}</i>` } }, w: 480, h: 300, x: i * 500, ...init });
    const studios = () => [...document.querySelectorAll<HTMLIFrameElement>('body > div[aria-hidden="true"] > iframe')];
    const studioOf = (i: number) => studios().find((f) => f.getAttribute('srcdoc')?.includes(`<i>${i}</i>`));
    const img = () => new Blob(['img'], { type: 'image/webp' });
    type Req = { id: number; w: number; h: number; vw: number; vh: number; op: string };
    // The frame loads; after the settle time it is asked for its snapshot.
    const ask = (f: HTMLIFrameElement) => {
      const post = vi.spyOn(f.contentWindow as Window, 'postMessage').mockImplementation(() => {});
      f.dispatchEvent(loadEvent());
      vi.advanceTimersByTime(PREVIEW_SETTLE_MS);
      const reqs = post.mock.calls.map((c) => c[0] as Req).filter((m) => m.op === 'snapshot');
      return { post, req: reqs.at(-1), count: reqs.length };
    };
    const reply = (f: HTMLIFrameElement, data: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { data, source: f.contentWindow as Window }));
    // Loaded, asked, answered with markup, drawn.
    const render = async (f: HTMLIFrameElement) => {
      const { req } = ask(f);
      reply(f, { cb: CB, op: 'snapshot', id: req!.id, ok: true, svg: '<svg/>' });
      await vi.advanceTimersByTimeAsync(0);
      return req!;
    };
    const setup = (opts: object = {}, deps: Partial<EmbedLayerDeps> = {}, cards: ElementInit[] = []) => {
      const rasterize = vi.fn(async () => img());
      const t = make(1, { ...NONE, ...opts }, 4, { rasterize, ...deps });
      const els = cards.map((c) => c as ReturnType<typeof snip>);
      t.store.add(els);
      t.tick();
      return { ...t, rasterize, els };
    };
    const srcOf = (t: ReturnType<typeof setup>, i: number) => posterOf(t.store, t.els[i].id);

    it('queues the snippet cards that are not live and have no picture of the host\'s, and nothing else', () => {
      const t = setup({ maxLive: 1, maxMounted: 1, previewWorkers: 2 }, {}, [
        snip(0),
        snip(1),
        snip(2),
        snip(3),
        snip(4, { media: { src: 'https://cdn.example/p.jpg', embed: { html: '<i>4</i>' } } }),
        embed(yt(5)),
      ]);
      expect(t.layer.live.size).toBe(1);
      // 3 snippets are not live: two in studios, one waiting. The host's picture and the video are left alone.
      expect(t.layer.previewsPending).toBe(3);
      expect(studios()).toHaveLength(2);
      expect(studioOf(4)).toBeUndefined();
      expect(studios().some((f) => f.getAttribute('srcdoc')?.includes('youtu'))).toBe(false);
      const live = [...t.layer.live][0];
      expect(studios().some((f) => f.getAttribute('srcdoc') === t.frames()[0].getAttribute('srcdoc'))).toBe(false);
      expect(live).toBeDefined();
    });

    it('renders in a hidden, inert, same-sandbox frame that takes no loading slot', () => {
      const t = setup({ previewWorkers: 1, maxLoading: 1 }, {}, [snip(0)]);
      const f = studios()[0];
      const box = f.parentElement as HTMLElement;
      expect(box.parentElement).toBe(document.body);
      expect(box.style.position).toBe('fixed');
      expect(box.style.opacity).toBe('0');
      expect(box.style.pointerEvents).toBe('none');
      expect(box.style.left).toBe('0px');
      expect(box.hasAttribute('inert')).toBe(true);
      expect(box.getAttribute('aria-hidden')).toBe('true');
      expect(f.tabIndex).toBe(-1);
      expect(f.getAttribute('sandbox')).toBe('allow-scripts');
      expect(f.getAttribute('srcdoc')).toContain('Content-Security-Policy');
      // Laid out like a live frame: the 720p virtual screen at the card's aspect (0.62 after bucketing).
      expect(f.style.height).toBe('720px');
      expect(parseFloat(f.style.width) / 720).toBeCloseTo(1000 / 620, 2);
      expect(t.layer.loading.size).toBe(0);
    });

    it('draws the nearest card to the centre of the view first, on screen before off screen', async () => {
      const t = setup({ previewWorkers: 1 }, {}, [
        snip(0, { x: 3000, y: 0 }),
        snip(1, { x: 0, y: 0 }),
        snip(2, { x: 560, y: 350 }),
        snip(3, { x: 4000, y: 0 }),
      ]);
      const order: number[] = [];
      for (let n = 0; n < 4; n++) {
        const f = studios()[0];
        order.push(Number(/<i>(\d)<\/i>/.exec(f.getAttribute('srcdoc')!)![1]));
        await render(f);
      }
      expect(order).toEqual([2, 1, 0, 3]);
      expect(t.layer.previewsPending).toBe(0);
      expect(studios()).toHaveLength(0);
    });

    it('re-ranks on settle: the new view first', async () => {
      const t = setup({ previewWorkers: 1 }, {}, [snip(0, { x: 0, y: 0 }), snip(1, { x: 3000, y: 0 }), snip(2, { x: 3200, y: 0 })]);
      await render(studios()[0]);
      // The camera moved to the right while the first was drawn; the next job is the one now in view.
      t.layer.onFrame(true);
      t.cam.tx = -3000;
      t.layer.onSettle();
      expect(/<i>(\d)<\/i>/.exec(studios()[0].getAttribute('srcdoc')!)![1]).toBe('1');
    });

    it('asks for the snapshot only after the settle time, with the layout size, and draws it at the frozen size', async () => {
      const t = setup({ previewWorkers: 1 }, {}, [snip(0)]);
      const f = studios()[0];
      const post = vi.spyOn(f.contentWindow as Window, 'postMessage').mockImplementation(() => {});
      f.dispatchEvent(loadEvent());
      vi.advanceTimersByTime(PREVIEW_SETTLE_MS - 1);
      expect(post).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      const [msg, target] = post.mock.calls[0] as [Req, string];
      expect(target).toBe('*');
      expect(msg).toMatchObject({ cb: CB, op: 'snapshot', vh: 720 });
      expect(msg.vw / msg.vh).toBeCloseTo(1000 / 620, 2);
      // As sharp as a frozen snapshot: 1.4 x freezePx on the short side, 640 px at most on the long one.
      expect(msg.h).toBe(196);
      expect(msg.w / msg.h).toBeCloseTo(1000 / 620, 1);
      reply(f, { cb: CB, op: 'snapshot', id: msg.id, ok: true, svg: '<svg><foreignObject/></svg>' });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.rasterize).toHaveBeenCalledWith('<svg><foreignObject/></svg>', msg.w, msg.h);
    });

    it('ignores replies that are not for the job: another source, another id, another cb', async () => {
      const t = setup({ previewWorkers: 1 }, {}, [snip(0)]);
      const f = studios()[0];
      const { req } = ask(f);
      const stranger = document.createElement('iframe');
      document.body.appendChild(stranger);
      window.dispatchEvent(new MessageEvent('message', { data: { cb: CB, op: 'snapshot', id: req!.id, ok: true, svg: '<svg/>' }, source: stranger.contentWindow as Window }));
      reply(f, { cb: CB, op: 'snapshot', id: req!.id + 1, ok: true, svg: '<svg/>' });
      reply(f, { cb: 'other', op: 'snapshot', id: req!.id, ok: true, svg: '<svg/>' });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.rasterize).not.toHaveBeenCalled();
      stranger.remove();
    });

    it('makes the picture the poster, and a late tile, a theme change or a retitle never cover it', async () => {
      let tile: (b: Blob) => void = () => {};
      drawTile.mockImplementation(() => new Promise<Blob | null>((r) => (tile = r)));
      const t = setup({ previewWorkers: 1 }, {}, [snip(0)]);
      await render(studios()[0]);
      expect(srcOf(t, 0)).toBe('blob:pv-0');
      // The tile arrives after the picture.
      tile(new Blob(['tile']));
      await vi.advanceTimersByTimeAsync(0);
      expect(srcOf(t, 0)).toBe('blob:pv-0');
      expect(revoked).toContain('blob:pv-1');
      drawTile.mockClear();
      t.layer.setTheme();
      const media = t.store.get(t.els[0].id)!.media;
      t.store.update(t.els[0].id, { media: { ...media, embed: { ...media.embed!, title: 'New' } } });
      await vi.advanceTimersByTimeAsync(0);
      expect(drawTile).not.toHaveBeenCalled();
      expect(srcOf(t, 0)).toBe('blob:pv-0');
      expect(t.layer.previewsPending).toBe(0);
    });

    it('lets the snapshot of a live frame replace the preview, but not the other way round', async () => {
      const t = setup({ previewWorkers: 1 }, {}, [snip(0)]);
      await render(studios()[0]);
      expect(srcOf(t, 0)).toBe('blob:pv-0');
      t.layer.setOptions({ maxLive: Infinity, maxMounted: Infinity, maxLoading: Infinity });
      t.tick();
      const live = t.frames()[0];
      live.dispatchEvent(loadEvent());
      const post = vi.spyOn(live.contentWindow as Window, 'postMessage').mockImplementation(() => {});
      t.cam.scale = 0.2;
      t.tick();
      const [req] = post.mock.calls.map((c) => c[0] as Req).filter((m) => m.op === 'snapshot');
      reply(live, { cb: CB, op: 'snapshot', id: req.id, ok: true, svg: '<svg/>' });
      await vi.advanceTimersByTimeAsync(0);
      expect(srcOf(t, 0)).toBe('blob:pv-1');
      // No new preview for a card that has a real picture.
      expect(t.layer.previewsPending).toBe(0);
    });

    it('draws a snippet that two cards share once', async () => {
      const t = setup({ previewWorkers: 1 }, {}, [snip(0), snip(0, { x: 600 })]);
      await render(studios()[0]);
      expect(t.rasterize).toHaveBeenCalledTimes(1);
      // The second card took the first one's picture without loading anything.
      expect(srcOf(t, 0)).toBeDefined();
      expect(srcOf(t, 1)).toBeDefined();
      expect(studios()).toHaveLength(0);
      expect(t.layer.previewsPending).toBe(0);
    });

    it('keeps the tile of a snippet that fails, and tries it once more, after the others', async () => {
      drawTile.mockResolvedValue(new Blob(['tile']));
      const t = setup({ previewWorkers: 1 }, {}, [snip(0, { x: 560, y: 350 }), snip(1, { x: 0, y: 0 })]);
      await vi.advanceTimersByTimeAsync(0);
      expect(srcOf(t, 0)).toBe('blob:pv-0');
      const f = studios()[0];
      expect(f.getAttribute('srcdoc')).toContain('<i>0</i>');
      const { req } = ask(f);
      reply(f, { cb: CB, op: 'snapshot', id: req!.id, ok: false });
      await vi.advanceTimersByTimeAsync(0);
      // The other card goes first now.
      expect(studios()[0].getAttribute('srcdoc')).toContain('<i>1</i>');
      await render(studios()[0]);
      expect(studios()[0].getAttribute('srcdoc')).toContain('<i>0</i>');
      const second = ask(studios()[0]);
      reply(studios()[0], { cb: CB, op: 'snapshot', id: second.req!.id, ok: false });
      await vi.advanceTimersByTimeAsync(0);
      // Twice is all: the tile stays, nothing is pending, no frame is left.
      expect(studios()).toHaveLength(0);
      expect(t.layer.previewsPending).toBe(0);
      expect(srcOf(t, 0)).toBe('blob:pv-0');
      vi.advanceTimersByTime(60000);
      expect(studios()).toHaveLength(0);
    });

    it('gives up on a frame that never loads after the time box, and on a blank drawing', async () => {
      const t = setup({ previewWorkers: 1 }, { rasterize: vi.fn(async () => null) }, [snip(0), snip(1, { x: 3000 })]);
      expect(studios()).toHaveLength(1);
      vi.advanceTimersByTime(PREVIEW_JOB_MS);
      // Next card (the failed one goes last).
      expect(studios()[0].getAttribute('srcdoc')).toContain('<i>1</i>');
      await render(studios()[0]);
      // Both have failed once; the nearer goes first.
      expect(t.layer.previewsPending).toBe(2);
      expect(studios()[0].getAttribute('srcdoc')).toContain('<i>0</i>');
      vi.advanceTimersByTime(PREVIEW_JOB_MS);
      expect(studios()[0].getAttribute('srcdoc')).toContain('<i>1</i>');
      vi.advanceTimersByTime(PREVIEW_JOB_MS);
      expect(studios()).toHaveLength(0);
      expect(t.layer.previewsPending).toBe(0);
    });

    it('holds the queue while the camera moves, and goes on when it settles', async () => {
      const t = make(1, { ...NONE, previewWorkers: 1 }, 4, { rasterize: async () => img() });
      t.store.add([snip(0), snip(1, { x: 600 })]);
      t.layer.onFrame(true);
      expect(studios()).toHaveLength(0);
      expect(t.layer.previewsPending).toBe(0);
      t.layer.onSettle();
      expect(studios()).toHaveLength(1);
      // Moving again: the running job finishes, the next one does not start.
      t.layer.onFrame(true);
      await render(studios()[0]);
      expect(studios()).toHaveLength(0);
      expect(t.layer.previewsPending).toBe(1);
      t.layer.onSettle();
      expect(studios()).toHaveLength(1);
    });

    it('does nothing with previewWorkers 0, and stops when it is set to 0', () => {
      const off = setup({ previewWorkers: 0 }, {}, [snip(0)]);
      expect(studios()).toHaveLength(0);
      expect(off.layer.previewsPending).toBe(0);
      off.layer.dispose();
      const t = setup({ previewWorkers: 2 }, {}, [snip(0), snip(1), snip(2)]);
      expect(studios()).toHaveLength(2);
      expect(t.layer.previewsPending).toBe(3);
      t.layer.setOptions({ previewWorkers: 0 });
      expect(studios()).toHaveLength(0);
      expect(t.layer.previewsPending).toBe(0);
      t.tick();
      expect(studios()).toHaveLength(0);
    });

    it('queues a card again when its live frame is destroyed before it got a picture', () => {
      const t = setup({ maxLive: 1, maxMounted: 1, previewWorkers: 1 }, {}, [snip(0), snip(1, { x: 600 })]);
      expect(t.layer.live.size).toBe(1);
      const liveId = [...t.layer.live][0];
      const other = t.els.find((e) => e.id !== liveId)!;
      expect(studios()[0].getAttribute('srcdoc')).toContain(String(other.media.embed!.html));
      // The live card moves out of the budget: its frame goes, and it is a candidate again.
      t.layer.setOptions({ maxMounted: 0, maxLive: 0 });
      t.tick();
      expect(t.layer.live.size).toBe(0);
      expect(t.layer.previewsPending).toBe(2);
    });

    it('removes its frames and timers on dispose', () => {
      const t = setup({ previewWorkers: 2 }, {}, [snip(0), snip(1), snip(2)]);
      ask(studios()[0]);
      expect(studios()).toHaveLength(2);
      t.layer.dispose();
      expect(studios()).toHaveLength(0);
      expect(document.querySelectorAll('body > div[aria-hidden="true"]')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('gives each job a frame of its own, and does not take a late load of the last job\'s document for the next one\'s', () => {
      const t = setup({ previewWorkers: 1 }, {}, [snip(0, { x: 560, y: 350 }), snip(1)]);
      const first = studios()[0];
      expect(first.getAttribute('srcdoc')).toContain('<i>0</i>');
      // The first never loads in time; the next job takes the studio.
      vi.advanceTimersByTime(PREVIEW_JOB_MS);
      const second = studios()[0];
      expect(second).not.toBe(first);
      expect(second.getAttribute('srcdoc')).toContain('<i>1</i>');
      expect(first.isConnected).toBe(false);
      const post = vi.spyOn(second.contentWindow as Window, 'postMessage').mockImplementation(() => {});
      // The load of the first document turns up now.
      first.dispatchEvent(loadEvent());
      vi.advanceTimersByTime(PREVIEW_SETTLE_MS * 2);
      expect(post).not.toHaveBeenCalled();
      // The second's own load is the one that counts, once.
      second.dispatchEvent(loadEvent());
      second.dispatchEvent(loadEvent());
      vi.advanceTimersByTime(PREVIEW_SETTLE_MS);
      expect(post.mock.calls.filter(([m]) => (m as { op?: string }).op === 'snapshot')).toHaveLength(1);
      expect(t.layer.previewsPending).toBe(2);
    });

    it('ignores a reply from the frame of a job that ended', async () => {
      const t = setup({ previewWorkers: 1 }, {}, [snip(0, { x: 560, y: 350 }), snip(1)]);
      const first = studios()[0];
      const { req } = ask(first);
      vi.advanceTimersByTime(PREVIEW_JOB_MS);
      expect(studios()[0]).not.toBe(first);
      reply(first, { cb: CB, op: 'snapshot', id: req!.id, ok: true, svg: '<svg/>' });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.rasterize).not.toHaveBeenCalled();
    });

    it('a card removed mid-job frees its frame for the next one', () => {
      const t = setup({ previewWorkers: 1 }, {}, [snip(0, { x: 560, y: 350 }), snip(1)]);
      expect(studios()[0].getAttribute('srcdoc')).toContain('<i>0</i>');
      t.store.remove([t.els[0].id]);
      expect(studios()[0].getAttribute('srcdoc')).toContain('<i>1</i>');
      expect(t.layer.previewsPending).toBe(1);
    });

    describe('cache', () => {
      let stored: Map<string, Blob>;
      const put = vi.fn();
      const open = vi.fn();
      beforeEach(() => {
        stored = new Map();
        put.mockReset();
        open.mockReset();
        vi.stubGlobal('caches', {
          open: async (name: string) => {
            open(name);
            return {
              match: async (url: string) => (stored.has(url) ? { blob: async () => stored.get(url)! } : undefined),
              put: async (url: string, res: Response) => {
                put(url, res);
                stored.set(url, await res.blob());
              },
            };
          },
        });
      });

      const PERSIST = { previewCache: 'persistent' };

      it('a hit in Cache Storage applies the picture without loading the snippet', async () => {
        const first = setup({ previewWorkers: 1, ...PERSIST }, {}, [snip(0)]);
        await vi.advanceTimersByTimeAsync(0);
        await render(studios()[0]);
        await vi.advanceTimersByTimeAsync(0);
        expect(open).toHaveBeenCalledWith('corkboard-previews-v1');
        expect(put).toHaveBeenCalledTimes(1);
        expect(put.mock.calls[0][0]).toMatch(/\/__corkboard_preview\/[0-9a-f]{16}$/);
        expect(stored.size).toBe(1);
        first.layer.dispose();
        // A new page: the same snippet is found, nothing is rendered.
        const t = setup({ previewWorkers: 1, ...PERSIST }, {}, [snip(0)]);
        expect(t.layer.previewsPending).toBe(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(studios()).toHaveLength(0);
        expect(t.rasterize).not.toHaveBeenCalled();
        expect(t.layer.previewsPending).toBe(0);
        expect(posterOf(t.store, t.els[0].id)).toMatch(/^blob:pv-/);
        expect(put).toHaveBeenCalledTimes(1);
      });

      it('does not touch Cache Storage by default (memory), and works without it', async () => {
        const t = setup({ previewWorkers: 1 }, {}, [snip(0)]);
        await render(studios()[0]);
        expect(open).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
        t.layer.dispose();
        vi.unstubAllGlobals();
        vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
        const u = setup({ previewWorkers: 1, ...PERSIST }, {}, [snip(1)]);
        await render(studios()[0]);
        expect(posterOf(u.store, u.els[0].id)).toMatch(/^blob:pv-/);
      });

      it('survives a Cache Storage that throws', async () => {
        vi.stubGlobal('caches', { open: async () => { throw new Error('private mode'); } });
        const t = setup({ previewWorkers: 1, ...PERSIST }, {}, [snip(0)]);
        await vi.advanceTimersByTimeAsync(0);
        await render(studios()[0]);
        expect(posterOf(t.store, t.els[0].id)).toMatch(/^blob:pv-/);
      });
    });
  });

  it('dispose removes everything', () => {
    const { store, layer, tick } = make();
    store.add([embed(yt())]);
    tick();
    layer.dispose();
    expect(root.querySelector('.cb-embed')).toBeNull();
    expect(layer.live.size).toBe(0);
  });
});
