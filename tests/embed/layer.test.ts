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
  REVEAL_MAX_MS,
  REVEAL_MS,
} from '../../src/embed/layer';
import { createElement } from '../../src/model';
import { DARK_THEME } from '../../src/render/theme';
import type { Stage } from '../../src/render/stage';
import { Store } from '../../src/store';
import type { ElementInit } from '../../src/types';

const VIEW = { w: 1600, h: 1000 };
// Cards whose poster texture has not landed on the fake stage yet.
const unlanded = new Set<string>();

// `fitRect` lands at once, the way the real camera does when its fly is over (clamped to `maxScale`).
function fakeStage(store: Store, scale = 1, maxScale = 4) {
  const cam = { tx: 0, ty: 0, scale };
  const stage = {
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
    // The sprite of a card shows a rendition (level >= 1) unless a test says its texture has not landed.
    viewOf: (id: string) => ({ variant: 'media', shown: unlanded.has(id) ? -1 : 1 }),
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
  return { stage: stage as unknown as Stage, cam };
}

let n = 0;
const embed = (init: Partial<ElementInit> & Pick<ElementInit, 'media'>) =>
  createElement({ w: 480, h: 300, x: 0, y: 0, ...init }, `e${n++}`);

let host: HTMLElement;
let root: HTMLElement;
let events: Array<[string, unknown]>;
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  document.body.innerHTML = '<div id="host" tabindex="0"><div id="root"></div></div>';
  host = document.getElementById('host') as HTMLElement;
  root = document.getElementById('root') as HTMLElement;
  events = [];
  unlanded.clear();
});
afterEach(() => {
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
      ...deps,
    },
    opts,
  );
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
      expect(store.get(el.id)?.media.src).toBe('blob:made-0');
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
      expect(store.get(own.id)?.media.src).toBe('blob:made-0');
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
      await vi.waitFor(() => expect(store.get(el.id)?.media.src).toBe('blob:made-1'));
      // Dropping the card's own title falls back to the resolver's.
      const media2 = store.get(el.id)!.media;
      store.update(el.id, { media: { ...media2, embed: { url: 'https://example.com/a' } } });
      await vi.waitFor(() => expect(drawTile).toHaveBeenCalledTimes(3));
      expect(drawTile.mock.calls[2][0].title).toBe('From resolver');
      expect(resolve).toHaveBeenCalledTimes(1);
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
      for (const f of frames()) f.dispatchEvent(new Event('load'));
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
    const load = (f: HTMLIFrameElement) => f.dispatchEvent(new Event('load'));
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
    const blob = () => new Blob(['img'], { type: 'image/webp' });
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
      const rasterize = vi.fn(async () => blob());
      const { store, el, f, post, w } = smallSvg(rasterize);
      const [req] = ops(post, 'snapshot');
      reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, svg: '<svg><foreignObject/></svg>' });
      expect(rasterize).toHaveBeenCalledWith('<svg><foreignObject/></svg>', req.w, req.h);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get(el.id)?.media.src).toBe('blob:snap-0');
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

    it('shows the snapshot as the poster, then hides the frame once its texture shows', () => {
      const { store, layer, el, f, post, w } = small();
      const [req] = ops(post, 'snapshot');
      reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, blob: blob() });
      expect(store.get(el.id)?.media.src).toBe('blob:snap-0');
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

    it('waits while the poster has not landed, and leaves the frame live if it never does', () => {
      const { layer, el, f, post, w } = small();
      unlanded.add(el.id);
      reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[0].id, ok: true, blob: blob() });
      vi.advanceTimersByTime(1000);
      expect(w.dataset.frozen).toBeUndefined();
      unlanded.delete(el.id);
      vi.advanceTimersByTime(150);
      expect(layer.frozen.has(el.id)).toBe(true);
    });

    it('leaves the frame live when the poster never lands', () => {
      const { layer, el, f, post, w } = small();
      unlanded.add(el.id);
      reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[0].id, ok: true, blob: blob() });
      vi.advanceTimersByTime(10000);
      expect(layer.frozen.has(el.id)).toBe(false);
      expect(w.dataset.frozen).toBeUndefined();
    });

    it('ignores replies from another source or with another id', () => {
      const { store, el, f, post, w, tick } = small();
      const [req] = ops(post, 'snapshot');
      const other = make(1, ALL);
      other.store.add([snippet(1)]);
      other.tick();
      const stranger = frameOf(1);
      reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, blob: blob() }, stranger.contentWindow);
      reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, blob: blob() }, window);
      reply(f, { cb: CB, op: 'snapshot', id: req.id + 1, ok: true, blob: blob() });
      reply(f, { cb: 'other', op: 'snapshot', id: req.id, ok: true, blob: blob() });
      expect(store.get(el.id)?.media.src).toBeUndefined();
      land();
      expect(w.dataset.frozen).toBeUndefined();
      // The real reply still works afterwards.
      reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, blob: blob() });
      expect(store.get(el.id)?.media.src).toBe('blob:snap-0');
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

    it('counts a reply without a picture as a failure', () => {
      const { layer, f, post, w, tick } = small();
      reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[0].id, ok: true, blob: 'not a blob' });
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

    it('shows the frame again at once when the card grows past 1.4x, not before', () => {
      const { layer, cam, el, f, post, w, tick } = small();
      reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[0].id, ok: true, blob: blob() });
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

    it('shows the frame when its card is selected or enters interact mode', () => {
      const { layer, cam, el, f, post, w, tick } = small();
      reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[0].id, ok: true, blob: blob() });
      land();
      expect(layer.frozen.has(el.id)).toBe(true);
      layer.setSelection([el.id]);
      layer.onFrame(false);
      expect(w.dataset.frozen).toBeUndefined();
      layer.setSelection([]);
      tick();
      expect(ops(post, 'snapshot')).toHaveLength(2);
      reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[1].id, ok: true, blob: blob() });
      land();
      expect(layer.frozen.has(el.id)).toBe(true);
      cam.scale = 0.3; // still small, over the minimum zoom to interact
      layer.setSelection([el.id]);
      expect(layer.interact(el.id)).toBe(true);
      expect(w.dataset.frozen).toBeUndefined();
      expect(layer.interacting).toBe(el.id);
      expect(ops(post, 'resume')).toHaveLength(2);
    });

    it('drops an answer that arrives after the card grew, and one for a destroyed frame', () => {
      const { store, cam, el, f, post, w, tick } = small();
      const [req] = ops(post, 'snapshot');
      cam.scale = 1;
      tick();
      reply(f, { cb: CB, op: 'snapshot', id: req.id, ok: true, blob: blob() });
      land();
      expect(store.get(el.id)?.media.src).toBeUndefined();
      expect(w.dataset.frozen).toBeUndefined();
    });

    it('never reports a snapshot blob as the persistable poster', async () => {
      const t = small();
      reply(t.f, { cb: CB, op: 'snapshot', id: ops(t.post, 'snapshot')[0].id, ok: true, blob: blob() });
      await Promise.resolve();
      expect(t.store.get(t.el.id)?.media.src).toBe('blob:snap-0');
      expect(events.filter(([type]) => type === 'embedResolved').every(([, p]) => (p as { poster?: string }).poster === undefined)).toBe(true);
    });

    it('keeps its snapshot when the theme changes (a tile would replace the last frame)', () => {
      const { layer, store, el, f, post } = small();
      reply(f, { cb: CB, op: 'snapshot', id: ops(post, 'snapshot')[0].id, ok: true, blob: blob() });
      drawTile.mockClear();
      layer.setTheme();
      expect(drawTile).not.toHaveBeenCalled();
      expect(store.get(el.id)?.media.src).toBe('blob:snap-0');
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

      describe('reveal', () => {
        it('makes a page transparent when it returns, for REVEAL_MS', () => {
          const t = video();
          away(t);
          expect(t.w.dataset.culled).toBeDefined();
          expect(t.w.dataset.revealing).toBeUndefined();
          back(t);
          expect(t.w.dataset.culled).toBeUndefined();
          expect(t.w.dataset.revealing).toBeDefined();
          vi.advanceTimersByTime(REVEAL_MS - 1);
          expect(t.w.dataset.revealing).toBeDefined();
          vi.advanceTimersByTime(1);
          expect(t.w.dataset.revealing).toBeUndefined();
        });

        it('asks a snippet to show, and clears on its painted, from that frame and that id only', () => {
          const t = one();
          away(t);
          vi.advanceTimersByTime(CULL_SNAPSHOT_MS);
          expect(t.w.dataset.culled).toBeDefined();
          back(t);
          expect(t.w.dataset.revealing).toBeDefined();
          const shows = ops(t.post, 'show');
          expect(shows).toHaveLength(1);
          const id = shows[0].id;
          reply(t.f, { cb: CB, op: 'painted', id: id + 1 });
          reply(t.f, { cb: 'other', op: 'painted', id });
          reply(t.f, { cb: CB, op: 'painted', id }, window);
          reply(t.f, { cb: CB, op: 'painted', id }, document.createElement('iframe').contentWindow);
          expect(t.w.dataset.revealing).toBeDefined();
          reply(t.f, { cb: CB, op: 'painted', id });
          expect(t.w.dataset.revealing).toBeUndefined();
          // Its timer is gone with it.
          vi.advanceTimersByTime(REVEAL_MAX_MS);
          expect(t.w.dataset.revealing).toBeUndefined();
        });

        it('falls back to REVEAL_MAX_MS when a snippet never says it painted', () => {
          const t = one();
          away(t);
          vi.advanceTimersByTime(CULL_SNAPSHOT_MS);
          back(t);
          vi.advanceTimersByTime(REVEAL_MS + 100);
          expect(t.w.dataset.revealing).toBeDefined();
          vi.advanceTimersByTime(REVEAL_MAX_MS);
          expect(t.w.dataset.revealing).toBeUndefined();
        });

        it('stops when the card leaves again or the frame is destroyed', () => {
          const t = video();
          away(t);
          back(t);
          expect(t.w.dataset.revealing).toBeDefined();
          away(t);
          expect(t.w.dataset.revealing).toBeUndefined();
          back(t);
          expect(t.w.dataset.revealing).toBeDefined();
          t.layer.setOptions({ maxOffscreen: 0 });
          t.store.remove([...t.store.ids()]);
          expect(t.w.isConnected).toBe(false);
          expect(t.w.dataset.revealing).toBeUndefined();
          expect(() => vi.advanceTimersByTime(REVEAL_MAX_MS)).not.toThrow();
        });

        it('keeps the veil of a frame that never loaded', () => {
          const t = make(1, CULL);
          t.store.add([embed({ ...yt(), w: 480, h: 270 })]);
          t.tick();
          const w = wrapperOf(t.frames()[0]);
          away(t);
          back(t);
          expect(w.dataset.revealing).toBeUndefined();
          expect(w.dataset.ready).toBeUndefined();
        });

        it('keeps the wrapper transparent between a snippet\'s load and its first paint', () => {
          const t = make(1, CULL);
          t.store.add([snippet()]);
          t.tick();
          const f = frameOf(0);
          const post = spy(f);
          const w = wrapperOf(f);
          expect(w.dataset.ready).toBeUndefined();
          expect(w.dataset.revealing).toBeUndefined();
          load(f);
          // `ready` turns the wrapper white and the iframe opaque; `revealing` keeps both see-through until painted.
          expect(w.dataset.ready).toBeDefined();
          expect(w.dataset.revealing).toBeDefined();
          const [show] = ops(post, 'show');
          reply(f, { cb: CB, op: 'painted', id: show.id });
          expect(w.dataset.revealing).toBeUndefined();
        });

        it('does the same for a page, for REVEAL_MS after its load', () => {
          const t = make(1, CULL);
          t.store.add([embed({ ...yt(), w: 480, h: 270 })]);
          t.tick();
          const f = t.frames()[0];
          load(f);
          expect(wrapperOf(f).dataset.revealing).toBeDefined();
          vi.advanceTimersByTime(REVEAL_MS);
          expect(wrapperOf(f).dataset.revealing).toBeUndefined();
        });

        it('waits to reveal a frame that loaded while hidden, until its card is back', () => {
          const t = make(1, CULL);
          t.store.add([snippet()]);
          t.tick();
          const f = frameOf(0);
          const post = spy(f);
          away(t);
          expect(wrapperOf(f).dataset.culled).toBeDefined();
          load(f);
          expect(wrapperOf(f).dataset.revealing).toBeUndefined();
          expect(ops(post, 'show')).toHaveLength(0);
          back(t);
          expect(wrapperOf(f).dataset.revealing).toBeDefined();
          expect(ops(post, 'show')).toHaveLength(1);
        });

        it('reveals a frozen frame when it thaws, over the snapshot poster', () => {
          const t = small();
          reply(t.f, { cb: CB, op: 'snapshot', id: ops(t.post, 'snapshot')[0].id, ok: true, blob: blob() });
          land();
          expect(t.w.dataset.frozen).toBeDefined();
          expect(t.w.dataset.revealing).toBeUndefined();
          // The card grows past the unfreeze size.
          t.cam.scale = 1;
          t.tick();
          expect(t.w.dataset.frozen).toBeUndefined();
          expect(t.w.dataset.revealing).toBeDefined();
          const [show] = ops(t.post, 'show');
          expect(show).toBeDefined();
          reply(t.f, { cb: CB, op: 'painted', id: show.id });
          expect(t.w.dataset.revealing).toBeUndefined();
        });

        it('reveals a frozen frame whose card left and came back bigger once, when it thaws', () => {
          const t = small();
          reply(t.f, { cb: CB, op: 'snapshot', id: ops(t.post, 'snapshot')[0].id, ok: true, blob: blob() });
          land();
          t.cam.scale = 1;
          t.cam.tx = AWAY;
          t.layer.onFrame(true);
          // Off screen, a frame is left as it is: it thaws on the way back, in the same frame as it shows.
          expect(t.w.dataset.culled).toBeDefined();
          expect(t.w.dataset.revealing).toBeUndefined();
          t.cam.tx = 0;
          t.layer.onFrame(true);
          expect(t.w.dataset.culled).toBeUndefined();
          expect(t.w.dataset.frozen).toBeUndefined();
          expect(t.w.dataset.revealing).toBeDefined();
          expect(ops(t.post, 'show')).toHaveLength(1);
        });

        it('does not reveal a frozen frame, which stays hidden', () => {
          const t = small();
          reply(t.f, { cb: CB, op: 'snapshot', id: ops(t.post, 'snapshot')[0].id, ok: true, blob: blob() });
          land();
          expect(t.w.dataset.frozen).toBeDefined();
          // Still small, so still frozen: the frame behind the poster is hidden whatever the card does.
          t.cam.tx = AWAY * 10;
          t.layer.onFrame(true);
          t.cam.tx = 0;
          t.layer.onFrame(true);
          expect(t.w.dataset.frozen).toBeDefined();
          expect(t.w.dataset.revealing).toBeUndefined();
        });
      });

      describe('last frame as the poster', () => {
        it('keeps the frame visible while it is snapshotted, then hides it when the reply is in', () => {
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
          reply(t.f, { cb: CB, op: 'snapshot', id: req.id, ok: true, blob: blob() });
          expect(t.w.dataset.culling).toBeUndefined();
          expect(t.w.dataset.culled).toBeDefined();
          // The poster is the last frame, and the frame is not frozen.
          expect(t.store.get(t.el.id)?.media.src).toBe('blob:snap-0');
          expect(t.layer.frozen.size).toBe(0);
          expect(t.w.dataset.frozen).toBeUndefined();
          expect(t.layer.live.has(t.el.id)).toBe(true);
        });

        it('hides the frame as soon as the markup is in, and sets the poster once it is drawn', async () => {
          const rasterize = vi.fn(async () => blob());
          const t = one({}, { rasterize });
          away(t);
          const [req] = asked(t.post);
          reply(t.f, { cb: CB, op: 'snapshot', id: req.id, ok: true, svg: '<svg><foreignObject/></svg>' });
          expect(rasterize).toHaveBeenCalledWith('<svg><foreignObject/></svg>', req.w, req.h);
          expect(t.w.dataset.culled).toBeDefined();
          expect(t.store.get(t.el.id)?.media.src).toBeUndefined();
          await vi.advanceTimersByTimeAsync(0);
          expect(t.store.get(t.el.id)?.media.src).toBe('blob:snap-0');
          expect(t.layer.frozen.size).toBe(0);
        });

        it('hides the frame after CULL_SNAPSHOT_MS when it does not answer', () => {
          const t = one();
          away(t);
          vi.advanceTimersByTime(CULL_SNAPSHOT_MS - 1);
          expect(t.w.dataset.culled).toBeUndefined();
          vi.advanceTimersByTime(1);
          expect(t.w.dataset.culled).toBeDefined();
          expect(t.w.dataset.culling).toBeUndefined();
          // A late answer still gives the poster.
          reply(t.f, { cb: CB, op: 'snapshot', id: asked(t.post)[0].id, ok: true, blob: blob() });
          expect(t.store.get(t.el.id)?.media.src).toBe('blob:snap-0');
        });

        it('hides the frame at once when the snapshot fails, and does not retry or block freezing', () => {
          const t = one();
          away(t);
          reply(t.f, { cb: CB, op: 'snapshot', id: asked(t.post)[0].id, ok: false });
          expect(t.w.dataset.culled).toBeDefined();
          expect(t.store.get(t.el.id)?.media.src).toBeUndefined();
          vi.advanceTimersByTime(10000);
          expect(asked(t.post)).toHaveLength(1);
        });

        it('cancels the pending cull when the card returns first, and ignores the late reply', () => {
          const t = one();
          away(t);
          const [req] = asked(t.post);
          back(t);
          expect(t.w.dataset.culling).toBeUndefined();
          expect(t.w.dataset.culled).toBeUndefined();
          // Never hidden, so nothing to reveal.
          expect(t.w.dataset.revealing).toBeUndefined();
          reply(t.f, { cb: CB, op: 'snapshot', id: req.id, ok: true, blob: blob() });
          vi.advanceTimersByTime(CULL_SNAPSHOT_MS * 2);
          expect(t.w.dataset.culled).toBeUndefined();
          expect(t.store.get(t.el.id)?.media.src).toBeUndefined();
          // It did not use up the throttle: the next time it leaves it is asked again.
          away(t);
          expect(asked(t.post)).toHaveLength(2);
        });

        it('does not snapshot a frame again within CULL_SNAPSHOT_MIN_MS', () => {
          const t = one();
          away(t);
          reply(t.f, { cb: CB, op: 'snapshot', id: asked(t.post)[0].id, ok: true, blob: blob() });
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

        it('hides at once what has nothing to snapshot: a page, a frozen frame, a frame that never loaded', () => {
          const v = video();
          away(v);
          expect(v.w.dataset.culled).toBeDefined();
          expect(v.w.dataset.culling).toBeUndefined();

          const fz = small();
          reply(fz.f, { cb: CB, op: 'snapshot', id: ops(fz.post, 'snapshot')[0].id, ok: true, blob: blob() });
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
    function build(opts: object = {}, scale = 1) {
      const clock = fakeRaf();
      const store = new Store();
      const { stage, cam } = fakeStage(store, scale);
      const layer = new EmbedLayer(
        { root, host, store, stage, emit: () => {}, raf: clock.raf, caf: clock.caf },
        { ...ALL, ...opts },
      );
      const tick = () => {
        layer.onFrame(false);
        layer.onSettle();
      };
      return { store, layer, cam, clock, tick };
    }
    const snippet = (i: number, init: Partial<ElementInit> = {}) =>
      embed({ media: { embed: { html: `<i>${i}</i>` } }, w: 480, h: 300, x: i * 500, ...init });
    const frameOf = (i: number) =>
      [...root.querySelectorAll<HTMLIFrameElement>('.cb-embed iframe')].find((f) => f.getAttribute('srcdoc')?.includes(`<i>${i}</i>`)) as HTMLIFrameElement;
    const load = (f: HTMLIFrameElement) => f.dispatchEvent(new Event('load'));
    const spy = (f: HTMLIFrameElement) => vi.spyOn(f.contentWindow as Window, 'postMessage').mockImplementation(() => {});
    // What a frame was sent, without the `show` that goes out when it first paints.
    const sentTo = (p: ReturnType<typeof spy>) => p.mock.calls.filter(([m]) => (m as { op?: string })?.op !== 'show');
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
      const many = (opts: object = {}) => {
        const t = build(opts, 0.2);
        const els = Array.from({ length: 20 }, (_, i) => snippet(i, { x: (i % 5) * 500, y: Math.floor(i / 5) * 320 }));
        t.store.add(els);
        t.tick();
        const fs = els.map((_, i) => frameOf(i));
        fs.forEach(load);
        const posts = fs.map(spy);
        const paused = () => posts.reduce((n, p) => n + ops(p, 'pause'), 0);
        const resumed = () => posts.reduce((n, p) => n + ops(p, 'resume'), 0);
        return { ...t, els, paused, resumed };
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

  it('dispose removes everything', () => {
    const { store, layer, tick } = make();
    store.add([embed(yt())]);
    tick();
    layer.dispose();
    expect(root.querySelector('.cb-embed')).toBeNull();
    expect(layer.live.size).toBe(0);
  });
});
