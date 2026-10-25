// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Camera } from '../../src/math';
import {
  FADE_OUT_MS,
  SPINNER_DELAY_MS,
  VideoOverlay,
  type VideoTarget,
} from '../../src/video/video';

const CAM: Camera = { tx: 0, ty: 0, scale: 1 };

const target = (over: Partial<VideoTarget> = {}): VideoTarget => ({
  id: 'v1',
  src: '/media/s/a/one.mp4',
  box: { x: 100, y: 40, w: 248, h: 310 },
  radius: 8,
  ...over,
});

let parent: HTMLElement;
let root: HTMLElement;
let overlay: VideoOverlay;
let play: MockInstance<() => Promise<void>>;
let pause: MockInstance<() => void>;
let load: MockInstance<() => void>;

// The overlay lets go of the network once its fade back to the thumbnail is over.
const fadeOut = (): void => void vi.advanceTimersByTime(FADE_OUT_MS + 40);

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom implements no media playback: stub the three methods the overlay uses.
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  parent = document.createElement('div');
  root = document.createElement('div');
  parent.appendChild(root);
  document.body.appendChild(parent);
  overlay = new VideoOverlay(root);
});

afterEach(() => {
  overlay.dispose();
  parent.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const video = (): HTMLVideoElement => {
  const v = root.querySelector('video');
  if (!v) throw new Error('no video');
  return v;
};

const styleMap = (el: HTMLElement): Map<string, string> => {
  const m = new Map<string, string>();
  for (const decl of (el.getAttribute('style') ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) m.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  }
  return m;
};

describe('VideoOverlay', () => {
  it('owns exactly one hidden <video> from the start', () => {
    expect(root.querySelectorAll('video')).toHaveLength(1);
    expect(video().style.display).toBe('none');
    expect(overlay.activeId).toBeNull();
  });

  it('is a muted, inline, looping, metadata-only video that never takes pointer events', () => {
    const v = video();
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.playsInline).toBe(true);
    expect(v.preload).toBe('metadata');
    expect(v.hasAttribute('muted')).toBe(true);
    expect(v.hasAttribute('playsinline')).toBe(true);
    expect(v.hasAttribute('disablepictureinpicture')).toBe(true);
    const m = styleMap(v);
    expect(m.get('pointer-events')).toBe('none');
    // The thumbnail (a WebGL sprite) is cropped to the card's shape: so is the video, or the fade shows two crops.
    expect(m.get('object-fit')).toBe('cover');
    expect(m.get('position')).toBe('absolute');
    expect(m.get('left')).toBe('0px');
    expect(m.get('top')).toBe('0px');
    expect(m.get('transform-origin')).toBe('0 0');
  });

  it('setPlayback() turns loop and sound on or off', () => {
    const v = video();
    overlay.setPlayback({ loop: false, muted: false });
    expect(v.loop).toBe(false);
    expect(v.muted).toBe(false);
    expect(v.hasAttribute('loop')).toBe(false);
    expect(v.hasAttribute('muted')).toBe(false);
    overlay.setPlayback({ loop: true, muted: true });
    expect(v.loop).toBe(true);
    expect(v.hasAttribute('muted')).toBe(true);
  });

  it('show() sets the source, world size and clip, and starts playing', () => {
    overlay.show(target(), CAM);
    const v = video();
    expect(overlay.activeId).toBe('v1');
    expect(v.getAttribute('src')).toBe('/media/s/a/one.mp4');
    expect(v.hasAttribute('poster')).toBe(false);
    expect(v.style.display).toBe('block');
    expect(v.style.width).toBe('248px');
    expect(v.style.height).toBe('310px');
    expect(v.style.clipPath).toBe('inset(0 round 8px)');
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('places the video with translate(tx + x * s, ty + y * s) scale(s)', () => {
    overlay.show(target(), { tx: 30, ty: -10, scale: 2 });
    expect(video().style.transform).toBe('translate(230px, 70px) scale(2)');
  });

  it('reuses the one element for another card and swaps the source', () => {
    overlay.show(target(), CAM);
    const first = video();
    overlay.show(target({ id: 'v2', src: '/media/s/a/two.mp4' }), CAM);
    expect(root.querySelectorAll('video')).toHaveLength(1);
    expect(video()).toBe(first);
    expect(overlay.activeId).toBe('v2');
    expect(first.getAttribute('src')).toBe('/media/s/a/two.mp4');
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('does not reassign the source when the same card is shown again', () => {
    overlay.show(target(), CAM);
    const v = video();
    const setAttr = vi.spyOn(v, 'src', 'set');
    overlay.show(target({ box: { x: 0, y: 0, w: 100, h: 100 } }), CAM);
    expect(setAttr).not.toHaveBeenCalled();
    expect(v.style.width).toBe('100px');
  });

  it('swallows an autoplay rejection and a synchronous play() failure', async () => {
    play.mockImplementationOnce(() =>
      Promise.reject(new DOMException('blocked', 'NotAllowedError')),
    );
    expect(() => overlay.show(target(), CAM)).not.toThrow();
    // Let the rejection settle: an unhandled one would fail the run.
    await Promise.resolve();
    await Promise.resolve();
    play.mockImplementationOnce(() => {
      throw new Error('not implemented');
    });
    expect(() => overlay.show(target({ id: 'v2' }), CAM)).not.toThrow();
    expect(overlay.activeId).toBe('v2');
  });

  it('plays muted when the video keeps sound but the browser refuses unmuted autoplay', async () => {
    overlay.setPlayback({ loop: true, muted: false });
    play.mockImplementationOnce(() =>
      Promise.reject(new DOMException('blocked', 'NotAllowedError')),
    );
    overlay.show(target(), CAM);
    const v = video();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(v.muted).toBe(true);
    // The next card tries with sound again.
    overlay.show(target({ id: 'v2', src: '/media/s/a/two.mp4' }), CAM);
    expect(v.muted).toBe(false);
  });

  it('hide() pauses, releases the network source and hides the element, after the fade', () => {
    overlay.show(target(), CAM);
    overlay.hide();
    fadeOut();
    const v = video();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(v.hasAttribute('src')).toBe(false);
    expect(v.style.display).toBe('none');
    expect(overlay.activeId).toBeNull();
    expect(root.querySelectorAll('video')).toHaveLength(1);
  });

  it('hide() with nothing shown does nothing', () => {
    overlay.hide();
    expect(pause).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('shows again after a hide, with the source back', () => {
    overlay.show(target(), CAM);
    overlay.hide();
    fadeOut();
    overlay.show(target(), CAM);
    expect(video().getAttribute('src')).toBe('/media/s/a/one.mp4');
    expect(video().style.display).toBe('block');
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('sync() writes only transform and is idempotent', () => {
    overlay.show(target(), CAM);
    const v = video();
    const without = (): string =>
      [...styleMap(v)]
        .filter(([k]) => k !== 'transform')
        .map(([k, val]) => `${k}:${val}`)
        .join(';');
    const before = without();
    overlay.sync({ tx: -50, ty: 20, scale: 0.5 });
    expect(without()).toBe(before);
    expect(v.style.transform).toBe('translate(0px, 40px) scale(0.5)');
    const attr = v.getAttribute('style');
    overlay.sync({ tx: -50, ty: 20, scale: 0.5 });
    expect(v.getAttribute('style')).toBe(attr);
  });

  it('sync() does nothing while hidden', () => {
    overlay.show(target(), CAM);
    overlay.hide();
    fadeOut();
    const attr = video().getAttribute('style');
    overlay.sync({ tx: 999, ty: 999, scale: 3 });
    expect(video().getAttribute('style')).toBe(attr);
  });

  it('dispose() removes the element and makes later calls inert', () => {
    overlay.show(target(), CAM);
    overlay.dispose();
    expect(root.querySelector('video')).toBeNull();
    expect(root.childElementCount).toBe(0);
    expect(() => {
      overlay.show(target(), CAM);
      overlay.sync(CAM);
      overlay.hide();
      overlay.dispose();
    }).not.toThrow();
    expect(root.childElementCount).toBe(0);
    expect(overlay.activeId).toBeNull();
  });

  it('sets no poster and lets nothing clamp the box (CSS resets style <video> with max-width: 100%)', () => {
    overlay.show(target(), CAM);
    const m = styleMap(video());
    expect(m.get('max-width')).toBe('none');
    expect(m.get('max-height')).toBe('none');
  });

  it('places a rotated card with the rotation in the transform', () => {
    overlay.show(target({ box: { x: 0, y: 0, w: 100, h: 200 }, rot: 90 }), CAM);
    // The top-left corner of a 100 x 200 card turned 90 degrees about its centre (50, 100) is (150, 50).
    expect(video().style.transform).toBe('translate(150px, 50px) scale(1) rotate(90deg)');
  });
});

describe('VideoOverlay.follow', () => {
  it('moves, resizes and rotates the shown video with its card', () => {
    overlay.show(target(), CAM);
    const v = video();
    expect(overlay.follow({ x: 300, y: 20, w: 248, h: 310, rot: 0 }, CAM)).toBe(false);
    expect(v.style.transform).toBe('translate(300px, 20px) scale(1)');
    expect(v.style.width).toBe('248px');
    // A resize reports itself (the card may now be too small to play) and rewrites the size.
    expect(overlay.follow({ x: 300, y: 20, w: 400, h: 500, rot: 0 }, CAM)).toBe(true);
    expect(v.style.width).toBe('400px');
    expect(v.style.height).toBe('500px');
    overlay.follow({ x: 300, y: 20, w: 400, h: 500, rot: 90 }, { tx: 10, ty: 0, scale: 2 });
    expect(v.style.transform).toBe('translate(1510px, 140px) scale(2) rotate(90deg)');
  });

  it('writes nothing when the card did not move, and does not touch the box of the target', () => {
    const t = target();
    overlay.show(t, CAM);
    const v = video();
    const set = vi.spyOn(v.style, 'transform', 'set');
    const size = vi.spyOn(v.style, 'width', 'set');
    overlay.follow({ ...t.box, rot: 0 }, CAM);
    overlay.follow({ ...t.box }, CAM);
    expect(set).not.toHaveBeenCalled();
    expect(size).not.toHaveBeenCalled();
    // The caller's rect is copied: mutating it later (a live preview object) moves nothing by itself.
    const live = { x: 100, y: 40, w: 248, h: 310, rot: 0 };
    overlay.follow(live, CAM);
    live.x = 999;
    overlay.sync(CAM);
    expect(v.style.transform).toBe('translate(100px, 40px) scale(1)');
    expect(t.box.x).toBe(100);
  });

  it('sync() keeps the followed rect, not the one it was shown at', () => {
    overlay.show(target(), CAM);
    overlay.follow({ x: 0, y: 0, w: 248, h: 310, rot: 0 }, CAM);
    overlay.sync({ tx: 5, ty: 6, scale: 2 });
    expect(video().style.transform).toBe('translate(5px, 6px) scale(2)');
  });

  it('does nothing while hidden or disposed', () => {
    expect(overlay.follow({ x: 1, y: 1, w: 1, h: 1 }, CAM)).toBe(false);
    overlay.show(target(), CAM);
    overlay.hide();
    fadeOut();
    const attr = video().getAttribute('style');
    expect(overlay.follow({ x: 9, y: 9, w: 9, h: 9 }, CAM)).toBe(false);
    expect(video().getAttribute('style')).toBe(attr);
  });
});

const host = (): HTMLElement => {
  const el = root.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('no host');
  return el;
};
const status = (): string => `${host().dataset.state}${host().dataset.busy ? '+busy' : ''}`;
const ring = (): HTMLElement => {
  const el = root.querySelector<HTMLElement>('.cb-spinner');
  if (!el) throw new Error('no ring');
  return el;
};

describe('VideoOverlay fade out', () => {
  it('goes back to the thumbnail first, then lets go of the network', () => {
    overlay.show(target(), CAM);
    overlay.hide();
    // Fading: the card is still the overlay's, the source is still there, the host says poster.
    expect(overlay.activeId).toBe('v1');
    expect(video().getAttribute('src')).toBe('/media/s/a/one.mp4');
    expect(video().style.display).toBe('block');
    expect(host().dataset.state).toBe('poster');
    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FADE_OUT_MS - 1);
    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(41);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(video().hasAttribute('src')).toBe(false);
    expect(overlay.activeId).toBeNull();
  });

  it('follows its card, and the camera, while it fades', () => {
    overlay.show(target(), CAM);
    overlay.hide();
    overlay.sync({ tx: 10, ty: 0, scale: 2 });
    expect(video().style.transform).toBe('translate(210px, 80px) scale(2)');
    expect(overlay.follow({ x: 0, y: 0, w: 248, h: 310, rot: 0 }, CAM)).toBe(false);
    expect(video().style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('the same card shown again during the fade carries on: no new source, no teardown', () => {
    overlay.show(target(), CAM);
    overlay.hide();
    vi.advanceTimersByTime(FADE_OUT_MS / 2);
    const setAttr = vi.spyOn(video(), 'src', 'set');
    overlay.show(target(), CAM);
    expect(setAttr).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FADE_OUT_MS * 4);
    expect(pause).not.toHaveBeenCalled();
    expect(video().getAttribute('src')).toBe('/media/s/a/one.mp4');
    expect(overlay.activeId).toBe('v1');
  });

  it('another card shown during the fade cuts the old one and starts clean', () => {
    overlay.show(target(), CAM);
    overlay.hide();
    overlay.show(target({ id: 'v2', src: '/media/s/a/two.mp4' }), CAM);
    expect(video().getAttribute('src')).toBe('/media/s/a/two.mp4');
    expect(overlay.activeId).toBe('v2');
    // The old fade's timer must not tear the new card down.
    vi.advanceTimersByTime(FADE_OUT_MS * 4);
    expect(video().getAttribute('src')).toBe('/media/s/a/two.mp4');
    expect(video().style.display).toBe('block');
  });

  it('a second hide() during the fade changes nothing', () => {
    overlay.show(target(), CAM);
    overlay.hide();
    vi.advanceTimersByTime(FADE_OUT_MS - 20);
    overlay.hide();
    // The first hide's timer is the only one: it still fires on its own schedule, once.
    vi.advanceTimersByTime(60);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('reduced motion: no fade to wait for, the network is released at once', () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
    try {
      overlay.show(target(), CAM);
      overlay.hide();
      expect(pause).toHaveBeenCalledTimes(1);
      expect(video().style.display).toBe('none');
    } finally {
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  });
});

describe('VideoOverlay first frame and buffering (lib/videoReveal.ts)', () => {
  let readyState = 0;
  let currentTime = 0;
  const media = (state: number, type: string, time = currentTime): void => {
    readyState = state;
    currentTime = time;
    video().dispatchEvent(new Event(type));
  };

  beforeEach(() => {
    readyState = 0;
    currentTime = 0;
    for (const [k, get] of [
      ['readyState', () => readyState],
      ['currentTime', () => currentTime],
      ['paused', () => false],
    ] as const)
      Object.defineProperty(video(), k, { configurable: true, get });
  });

  it('is one host with the video and its ring, with the shared look classes', () => {
    expect(host().style.display).toBe('contents');
    expect(video().className).toBe('cb-video');
    expect(ring().className).toBe('cb-spinner');
    expect(ring().firstElementChild?.className).toBe('cb-ring');
    expect(host().dataset.state).toBe('poster');
  });

  it('keeps the card showing (poster) until a frame of the video is on screen, then reveals it', () => {
    overlay.show(target(), CAM);
    expect(status()).toBe('loading');
    media(1, 'loadedmetadata');
    media(1, 'loadstart');
    media(2, 'loadeddata');
    // Data is not a picture on screen: `playing` with the clock still at 0 is not a frame either.
    media(4, 'playing', 0);
    expect(status()).toBe('loading');
    media(4, 'timeupdate', 0.05);
    expect(status()).toBe('playing');
  });

  it('shows the ring only after a wait long enough to be one, and takes it away with the frame', () => {
    overlay.show(target(), CAM);
    vi.advanceTimersByTime(SPINNER_DELAY_MS - 1);
    expect(status()).toBe('loading');
    vi.advanceTimersByTime(1);
    expect(status()).toBe('loading+busy');
    media(4, 'playing', 0.1);
    expect(status()).toBe('playing');
  });

  it('never shows the ring for a video that is up at once (cached)', () => {
    overlay.show(target(), CAM);
    media(4, 'playing', 0.05);
    vi.advanceTimersByTime(SPINNER_DELAY_MS * 4);
    expect(status()).toBe('playing');
  });

  it('shows the ring again when playback stalls, over the last frame (no fall back to the card)', () => {
    overlay.show(target(), CAM);
    media(4, 'playing', 0.1);
    media(2, 'waiting');
    expect(status()).toBe('stalled');
    vi.advanceTimersByTime(SPINNER_DELAY_MS);
    expect(status()).toBe('stalled+busy');
    media(4, 'playing', 0.3);
    expect(status()).toBe('playing');
  });

  it('follows the stalled event too', () => {
    overlay.show(target(), CAM);
    media(4, 'playing', 0.1);
    media(1, 'stalled');
    vi.advanceTimersByTime(SPINNER_DELAY_MS);
    expect(status()).toBe('stalled+busy');
  });

  it('a broken source keeps the card and spins nothing', () => {
    overlay.show(target(), CAM);
    Object.defineProperty(video(), 'error', { configurable: true, value: { code: 4 } });
    video().dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(SPINNER_DELAY_MS * 4);
    expect(status()).toBe('poster');
  });

  it('centres the ring on the card, upright, whatever the rotation or zoom', () => {
    overlay.show(target({ box: { x: 0, y: 0, w: 100, h: 200 }, rot: 90 }), {
      tx: 10,
      ty: 20,
      scale: 2,
    });
    // Centre of the box on screen: (10 + 50 * 2, 20 + 100 * 2) = (110, 220); the disc is 52 px.
    expect(ring().style.transform).toBe('translate(84px, 194px)');
    overlay.follow({ x: 100, y: 0, w: 100, h: 200, rot: 0 }, { tx: 10, ty: 20, scale: 2 });
    expect(ring().style.transform).toBe('translate(284px, 194px)');
  });

  it('a new source starts from the card again: poster, waiting', () => {
    overlay.show(target(), CAM);
    media(4, 'playing', 0.1);
    expect(status()).toBe('playing');
    // Assigning `src` resets the element's readyState in the browser; jsdom does not.
    readyState = 0;
    overlay.show(target({ id: 'v2', src: '/media/s/a/two.mp4' }), CAM);
    expect(status()).toBe('loading');
    vi.advanceTimersByTime(SPINNER_DELAY_MS);
    expect(status()).toBe('loading+busy');
  });

  it('hide() clears the ring and brings the card back, and a pending timer does not bring the ring back', () => {
    overlay.show(target(), CAM);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);
    expect(status()).toBe('loading+busy');
    overlay.hide();
    expect(status()).toBe('poster');
    fadeOut();
    overlay.show(target({ id: 'v2', src: '/x.mp4' }), CAM);
    overlay.hide();
    vi.advanceTimersByTime(SPINNER_DELAY_MS * 2);
    expect(status()).toBe('poster');
  });

  it('dispose() removes the host with the video and the ring and stops listening', () => {
    overlay.show(target(), CAM);
    const v = video();
    overlay.dispose();
    expect(root.childElementCount).toBe(0);
    expect(() => {
      readyState = 4;
      v.dispatchEvent(new Event('canplay'));
      vi.advanceTimersByTime(SPINNER_DELAY_MS * 2);
    }).not.toThrow();
  });
});

describe('VideoOverlay pending (the hover delay)', () => {
  it('starts the ring’s wait with the hover, fetches nothing yet', () => {
    overlay.show(target(), CAM, false);
    expect(overlay.activeId).toBe('v1');
    expect(video().hasAttribute('src')).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(status()).toBe('loading');
    vi.advanceTimersByTime(SPINNER_DELAY_MS);
    expect(status()).toBe('loading+busy');
    // The centre of the 248 x 310 box at (100, 40): (224, 195), less half the 52 px disc.
    expect(ring().style.transform).toBe('translate(198px, 169px)');
  });

  it('the load that follows keeps the wait going: the ring does not start over', () => {
    overlay.show(target(), CAM, false);
    vi.advanceTimersByTime(200);
    overlay.show(target(), CAM);
    expect(video().getAttribute('src')).toBe('/media/s/a/one.mp4');
    expect(play).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SPINNER_DELAY_MS - 200);
    expect(status()).toBe('loading+busy');
  });

  it('a hover that ended first takes the ring away and leaves nothing to release', () => {
    overlay.show(target(), CAM, false);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);
    overlay.hide();
    expect(status()).toBe('poster');
    fadeOut();
    expect(load).not.toHaveBeenCalled();
    expect(overlay.activeId).toBeNull();
  });
});

describe('VideoOverlay with frame callbacks', () => {
  const frames: Array<() => void> = [];
  let own: VideoOverlay;
  let ownRoot: HTMLElement;

  beforeEach(() => {
    frames.length = 0;
    (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback = (
      cb: () => void,
    ) => frames.push(cb);
    (HTMLVideoElement.prototype as unknown as Record<string, unknown>).cancelVideoFrameCallback =
      () => {};
    ownRoot = document.createElement('div');
    parent.appendChild(ownRoot);
    own = new VideoOverlay(ownRoot);
  });
  afterEach(() => {
    own.dispose();
    ownRoot.remove();
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)
      .requestVideoFrameCallback;
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)
      .cancelVideoFrameCallback;
  });

  it('reveals the video on the presented frame', () => {
    own.show(target(), CAM);
    const h = ownRoot.firstElementChild as HTMLElement;
    ownRoot.querySelector('video')?.dispatchEvent(new Event('playing'));
    expect(h.dataset.state).toBe('loading');
    frames.splice(0).forEach((cb) => cb());
    expect(h.dataset.state).toBe('playing');
  });
});

describe('VideoOverlay in world space (the ambient pool)', () => {
  it('is placed by the card alone: the camera is the parent’s, not its own', () => {
    overlay.dispose();
    overlay = new VideoOverlay(root, { spinner: false, worldSpace: true });
    overlay.show(target(), { tx: -500, ty: 80, scale: 0.2 });
    expect(video().style.transform).toBe('translate(100px, 40px) scale(1)');
    // The camera moves: nothing is written on the element.
    overlay.sync({ tx: 40, ty: 40, scale: 3 });
    expect(video().style.transform).toBe('translate(100px, 40px) scale(1)');
    // The card moves: it is.
    overlay.follow({ x: 300, y: 40, w: 248, h: 310 }, { tx: 40, ty: 40, scale: 3 });
    expect(video().style.transform).toBe('translate(300px, 40px) scale(1)');
  });

  it('rotates about the card’s centre, in world px', () => {
    overlay.dispose();
    overlay = new VideoOverlay(root, { spinner: false, worldSpace: true });
    overlay.show(target({ box: { x: 0, y: 0, w: 100, h: 100 }, rot: 90 }), CAM);
    expect(video().style.transform).toBe('translate(100px, 0px) scale(1) rotate(90deg)');
  });
});
