// The embed layer against a real Store and a stub stage: what it mounts, with which attributes, how many,
// and how interact mode behaves. Posters need canvas and network, which jsdom has not: they are not under
// test here (the tile and provider logic is, in their own files).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const drawTile = vi.hoisted(() => vi.fn<(spec: { title: string }) => Promise<Blob | null>>(async () => null));
vi.mock('../../src/embed/tile', async (orig) => ({
  ...(await orig<typeof import('../../src/embed/tile')>()),
  drawTile,
}));
import { EmbedLayer, type EmbedEvents } from '../../src/embed/layer';
import { MIN_LIVE_SCALE } from '../../src/embed/policy';
import { createElement } from '../../src/model';
import { DARK_THEME } from '../../src/render/theme';
import type { Stage } from '../../src/render/stage';
import { Store } from '../../src/store';
import type { ElementInit } from '../../src/types';

const VIEW = { w: 1600, h: 1000 };

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
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  drawTile.mockReset();
  drawTile.mockResolvedValue(null);
});

function make(scale = 1, opts = {}, maxScale = 4) {
  const store = new Store();
  const { stage, cam } = fakeStage(store, scale, maxScale);
  const layer = new EmbedLayer(
    {
      root,
      host,
      store,
      stage,
      emit: <K extends keyof EmbedEvents>(type: K, payload: EmbedEvents[K]) => void events.push([type, payload]),
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

const yt = (i = 0) => ({ media: { embed: { url: `https://youtu.be/dQw4w9WgX${String(i).padStart(2, '0')}`.slice(0, 31) } } });

describe('EmbedLayer', () => {
  it('mounts one sandboxed iframe for a big card, with the provider profile', () => {
    const { store, frames, tick } = make();
    store.add([embed(yt())]);
    tick();
    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0].getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgX00');
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
    const { store, layer, frames, tick } = make(0.4);
    store.add([embed({ ...yt(), w: 480, h: 270 })]);
    const id = [...store.ids()][0];
    tick();
    expect(frames()).toHaveLength(0);
    layer.setSelection([id]);
    tick();
    expect(frames()).toHaveLength(1);
  });

  it('never mounts below the minimum zoom, even selected', () => {
    const { store, layer, frames, tick } = make(0.1);
    store.add([embed(yt())]);
    layer.setSelection([...store.ids()]);
    tick();
    expect(frames()).toHaveLength(0);
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
    expect(frames()).toHaveLength(1);
  });

  it('allows one live iframe on touch', () => {
    const { store, layer, frames, tick } = make();
    store.add(Array.from({ length: 3 }, (_, i) => embed({ ...yt(i), x: i * 500 })));
    layer.setTouch(true);
    tick();
    expect(frames()).toHaveLength(1);
    expect(layer.maxLive).toBe(1);
  });

  it('evicts the least recently used live card for a selected one, and destroys its iframe', () => {
    const { store, layer, frames, tick } = make(1, { maxLive: 2 });
    const els = Array.from({ length: 3 }, (_, i) => embed({ ...yt(i), x: i * 500 }));
    store.add(els);
    layer.setSelection([els[0].id]);
    tick();
    layer.setSelection([els[1].id]);
    tick();
    expect(layer.live).toEqual(new Set([els[0].id, els[1].id]));
    const dropped = frames().find((f) => f.getAttribute('src')?.endsWith('00')) as HTMLIFrameElement;
    layer.setSelection([els[2].id]);
    tick();
    expect(layer.live).toEqual(new Set([els[1].id, els[2].id]));
    expect(frames()).toHaveLength(2);
    expect(dropped.isConnected).toBe(false);
    expect(dropped.getAttribute('src')).toBe('about:blank');
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

  it('dispose removes everything', () => {
    const { store, layer, tick } = make();
    store.add([embed(yt())]);
    tick();
    layer.dispose();
    expect(root.querySelector('.cb-embed')).toBeNull();
    expect(layer.live.size).toBe(0);
  });
});
