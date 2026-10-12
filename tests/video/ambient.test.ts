// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Camera } from '../../src/math';
import {
  AmbientVideos,
  MAX_IDLE,
  REPLAN_THROTTLE_MS,
  START_SPACING_MS,
  STARTS_PER_PASS,
} from '../../src/video/ambient';
import {
  AMBIENT_MAX_STREAMS,
  type AmbientCandidate,
  type AmbientEnv,
} from '../../src/video/ambientPolicy';
import { FADE_OUT_MS, type VideoTarget } from '../../src/video/video';

interface Card {
  x: number;
  y: number;
  w: number;
  h: number;
  src?: string;
}

let play: MockInstance<() => Promise<void>>;
let pause: MockInstance<() => void>;
let parent: HTMLElement;
let root: HTMLElement;
let cards: Map<string, Card>;
let camera: Camera;
let envState: { reduced: boolean; saveData: boolean; hidden: boolean };
let pool: AmbientVideos;
let changes: number;

const env: AmbientEnv = {
  reducedMotion: () => envState.reduced,
  saveData: () => envState.saveData,
  hidden: () => envState.hidden,
};

const VIEW = { w: 1000, h: 800 };

function make(): AmbientVideos {
  return new AmbientVideos({
    root,
    camera: () => camera,
    viewport: () => VIEW,
    *candidates(): IterableIterator<AmbientCandidate> {
      for (const [id, c] of cards) if (c.src) yield { id, x: c.x, y: c.y, w: c.w, h: c.h };
    },
    target(id): VideoTarget | null {
      const c = cards.get(id);
      if (!c?.src) return null;
      return { id, src: c.src, box: { x: c.x, y: c.y, w: c.w, h: c.h }, radius: 8 };
    },
    onChange: () => void changes++,
    env,
  });
}

// `n` video cards laid out in a grid of 200 px cards (5 per row): the first 20 fill the first screenful
// (5 x 4 in 1000 x 800); `size` shrinks the grid, as a zoomed-out canvas would.
function addCards(n: number, from = 0, size = 200): void {
  for (let i = from; i < from + n; i++) {
    cards.set(`c${String(i).padStart(3, '0')}`, {
      x: (i % 5) * size,
      y: Math.floor(i / 5) * size,
      w: size - 10,
      h: size - 10,
      src: `/media/${i}.mp4`,
    });
  }
}

const videos = (): HTMLVideoElement[] => [...root.querySelectorAll('video')];
const withSrc = (): HTMLVideoElement[] => videos().filter((v) => v.hasAttribute('src'));
const srcs = (): string[] =>
  withSrc()
    .map((v) => v.getAttribute('src') ?? '')
    .sort();

// Lets the throttle / start spacing pass until the pool is quiet.
const settle = (): void => void vi.advanceTimersByTime(START_SPACING_MS * 30);
const fadeOut = (): void => void vi.advanceTimersByTime(FADE_OUT_MS + 40);

beforeEach(() => {
  vi.useFakeTimers();
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  parent = document.createElement('div');
  root = document.createElement('div');
  parent.appendChild(root);
  document.body.appendChild(parent);
  cards = new Map();
  camera = { tx: 0, ty: 0, scale: 1 };
  envState = { reduced: false, saveData: false, hidden: false };
  changes = 0;
  pool = make();
});

afterEach(() => {
  pool.dispose();
  parent.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const on = (over: Partial<{ always: boolean; loop: boolean; muted: boolean }> = {}): void =>
  pool.setOptions({ always: true, loop: true, muted: true, ...over });

describe('AmbientVideos: switched off (the default)', () => {
  it('plays nothing and creates no element', () => {
    addCards(4);
    pool.setOptions({ always: false, loop: true, muted: true });
    settle();
    expect(videos()).toHaveLength(0);
    expect(pool.playingIds.size).toBe(0);
  });

  it('costs nothing while the cards change: no timer, no work', () => {
    addCards(4);
    pool.setOptions({ always: false, loop: true, muted: true });
    pool.invalidate();
    pool.sync(camera);
    pool.follow(camera);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is switched off again: every stream is let go of', () => {
    addCards(3);
    on();
    settle();
    expect(withSrc()).toHaveLength(3);
    pool.setOptions({ always: false, loop: true, muted: true });
    fadeOut();
    expect(withSrc()).toHaveLength(0);
    expect(pool.playingIds.size).toBe(0);
  });
});

describe('AmbientVideos: what plays', () => {
  it('plays the video cards in view, muted, looping and inline', () => {
    addCards(3);
    on();
    settle();
    expect(srcs()).toEqual(['/media/0.mp4', '/media/1.mp4', '/media/2.mp4']);
    for (const v of withSrc()) {
      expect(v.muted).toBe(true);
      expect(v.loop).toBe(true);
      expect(v.playsInline).toBe(true);
      expect(v.getAttribute('playsinline')).toBe('');
    }
    expect(play).toHaveBeenCalledTimes(3);
  });

  it('never makes a sound, even when sound is on', () => {
    addCards(2);
    on({ muted: false });
    settle();
    for (const v of withSrc()) expect(v.muted).toBe(true);
  });

  it('follows the loop switch', () => {
    addCards(2);
    on({ loop: false });
    settle();
    for (const v of withSrc()) expect(v.loop).toBe(false);
    on({ loop: true });
    for (const v of videos()) expect(v.loop).toBe(true);
  });

  it('ignores cards without a video', () => {
    addCards(2);
    cards.set('img', { x: 0, y: 0, w: 190, h: 190 });
    on();
    settle();
    expect(withSrc()).toHaveLength(2);
    expect(pool.isPlaying('img')).toBe(false);
  });

  it('starts at most a few streams at a time, a few frames apart, and all of them within a second', () => {
    const n = STARTS_PER_PASS * 2 + 3;
    addCards(n);
    on();
    expect(withSrc()).toHaveLength(STARTS_PER_PASS);
    vi.advanceTimersByTime(START_SPACING_MS);
    expect(withSrc()).toHaveLength(STARTS_PER_PASS * 2);
    vi.advanceTimersByTime(START_SPACING_MS);
    expect(withSrc()).toHaveLength(n);
    // 40 cards: every one is up in under a second.
    pool.dispose();
    pool = make();
    cards.clear();
    addCards(40, 0, 100);
    on();
    vi.advanceTimersByTime(1000);
    expect(withSrc()).toHaveLength(40);
  });
});

describe('AmbientVideos: only what is in view plays', () => {
  it('lets go of a card that scrolls out of view and starts the one that scrolls in', () => {
    addCards(2);
    cards.set('far', { x: 5000, y: 0, w: 190, h: 190, src: '/media/far.mp4' });
    on();
    settle();
    expect(srcs()).toEqual(['/media/0.mp4', '/media/1.mp4']);
    expect(pool.isPlaying('far')).toBe(false);

    camera = { tx: -4900, ty: 0, scale: 1 };
    pool.settle();
    expect(pool.isPlaying('far')).toBe(true);
    expect(pool.isPlaying('c000')).toBe(false);
    fadeOut();
    expect(srcs()).toEqual(['/media/far.mp4']);
  });

  it('keeps the number of elements at the number of playing cards (an element is reused)', () => {
    addCards(1);
    cards.set('far', { x: 5000, y: 0, w: 190, h: 190, src: '/media/far.mp4' });
    on();
    settle();
    expect(videos()).toHaveLength(1);
    camera = { tx: -4900, ty: 0, scale: 1 };
    pool.settle();
    settle();
    expect(videos()).toHaveLength(1);
  });

  it('refreshes the plan on its own while the camera moves, throttled', () => {
    addCards(1);
    cards.set('far', { x: 5000, y: 0, w: 190, h: 190, src: '/media/far.mp4' });
    on();
    settle();
    camera = { tx: -4900, ty: 0, scale: 1 };
    // Frames of a pan: the elements are moved at once, the plan waits for its throttle.
    pool.sync(camera);
    pool.sync(camera);
    expect(pool.isPlaying('far')).toBe(false);
    vi.advanceTimersByTime(REPLAN_THROTTLE_MS + 1);
    expect(pool.isPlaying('far')).toBe(true);
  });

  it('moves all the elements with the camera by ONE transform, on their shared layer', () => {
    addCards(5);
    on();
    settle();
    const layer = withSrc()[0].parentElement!.parentElement as HTMLElement;
    for (const v of withSrc()) expect(v.parentElement!.parentElement).toBe(layer);
    const before = withSrc().map((v) => v.style.transform);
    camera = { tx: -20, ty: 5, scale: 0.5 };
    pool.sync(camera);
    expect(layer.style.transform).toBe('translate(-20px, 5px) scale(0.5)');
    // Panning and zooming write nothing on the videos themselves.
    expect(withSrc().map((v) => v.style.transform)).toEqual(before);
    pool.follow(camera);
    expect(withSrc().map((v) => v.style.transform)).toEqual(before);
  });

  it('puts an element that starts after the camera moved where the camera is', () => {
    camera = { tx: -300, ty: -40, scale: 0.25 };
    addCards(1, 0, 1000);
    on();
    settle();
    const layer = withSrc()[0].parentElement!.parentElement as HTMLElement;
    expect(layer.style.transform).toBe('translate(-300px, -40px) scale(0.25)');
  });

  it('follows a card that is moved (in world space, whatever the camera)', () => {
    addCards(1);
    on();
    settle();
    const v = withSrc()[0];
    camera = { tx: 100, ty: 0, scale: 2 };
    pool.sync(camera);
    cards.get('c000')!.x = 300;
    pool.follow(camera);
    expect(v.style.transform).toContain('translate(300px, 0px)');
  });

  it('lets go of a card that is deleted', () => {
    addCards(2);
    on();
    settle();
    cards.delete('c001');
    pool.follow(camera);
    vi.advanceTimersByTime(REPLAN_THROTTLE_MS + 1);
    expect(pool.isPlaying('c001')).toBe(false);
    expect(pool.isPlaying('c000')).toBe(true);
  });

  it('picks up a card whose video arrived late', () => {
    addCards(1);
    cards.set('late', { x: 400, y: 0, w: 190, h: 190 });
    on();
    settle();
    expect(pool.isPlaying('late')).toBe(false);
    cards.get('late')!.src = '/media/late.mp4';
    pool.invalidate();
    vi.advanceTimersByTime(REPLAN_THROTTLE_MS + 1);
    expect(pool.isPlaying('late')).toBe(true);
  });
});

describe('AmbientVideos: every card in view plays', () => {
  it('plays all of them, however many: no cap on what is on screen', () => {
    addCards(40, 0, 100);
    on();
    settle();
    expect(withSrc()).toHaveLength(40);
    expect(pool.playingIds.size).toBe(40);
  });

  it('plays a card at any zoom, however small it is on screen', () => {
    addCards(25, 0, 400);
    on();
    for (const scale of [1, 0.25, 0.1, 0.03]) {
      camera = { tx: 0, ty: 0, scale };
      pool.settle();
      settle();
      // Every card whose box touches the viewport plays (the margin may add a few more).
      const inView = [...cards.entries()].filter(
        ([, c]) => c.x * scale < VIEW.w && c.y * scale < VIEW.h,
      );
      expect(inView.length).toBeGreaterThan(0);
      for (const [id] of inView) expect(pool.isPlaying(id), `${id} at zoom ${scale}`).toBe(true);
    }
    expect(pool.playingIds.size).toBe(25);
  });

  it('plays every card when the camera zooms out after being zoomed in', () => {
    addCards(30, 0, 400);
    on();
    settle();
    const zoomedIn = pool.playingIds.size;
    expect(zoomedIn).toBeLessThan(30);
    camera = { tx: 0, ty: 0, scale: 0.05 };
    pool.settle();
    settle();
    expect(pool.playingIds.size).toBe(30);
    expect(withSrc()).toHaveLength(30);
  });

  it('plays the biggest cards first when it has to choose (the safety ceiling)', () => {
    addCards(AMBIENT_MAX_STREAMS + 8, 0, 20);
    cards.set('big', { x: 100, y: 100, w: 400, h: 400, src: '/media/big.mp4' });
    on();
    settle();
    expect(pool.playingIds.size).toBe(AMBIENT_MAX_STREAMS);
    expect(pool.isPlaying('big')).toBe(true);
  });

  it('reuses its elements while cards come and go (a pan creates no new ones)', () => {
    addCards(20);
    on();
    settle();
    const made = videos().length;
    expect(made).toBe(20);
    for (let step = 0; step < 6; step++) {
      camera = { tx: -step * 150, ty: -step * 90, scale: 1 };
      pool.settle();
      settle();
      expect(videos().length).toBeLessThanOrEqual(made);
    }
  });

  it('keeps no more than a few spare elements once the cards are gone', () => {
    addCards(40, 0, 100);
    on();
    settle();
    expect(videos()).toHaveLength(40);
    camera = { tx: -50_000, ty: 0, scale: 1 };
    pool.settle();
    fadeOut();
    expect(withSrc()).toHaveLength(0);
    expect(videos().length).toBeLessThanOrEqual(MAX_IDLE);
  });
});

describe('AmbientVideos: the page’s own limits', () => {
  it('plays nothing with prefers-reduced-motion', () => {
    envState.reduced = true;
    addCards(3);
    on();
    settle();
    expect(videos()).toHaveLength(0);
  });

  it('plays nothing when the extra reduced-motion switch is on', () => {
    pool.dispose();
    let reduced = true;
    pool = new AmbientVideos({
      root,
      camera: () => camera,
      viewport: () => VIEW,
      *candidates() {
        for (const [id, c] of cards) yield { id, x: c.x, y: c.y, w: c.w, h: c.h };
      },
      target: (id) => {
        const c = cards.get(id);
        return c?.src
          ? { id, src: c.src, box: { x: c.x, y: c.y, w: c.w, h: c.h }, radius: 8 }
          : null;
      },
      env,
      reducedMotion: () => reduced,
    });
    addCards(2);
    on();
    settle();
    expect(withSrc()).toHaveLength(0);
    reduced = false;
    pool.settle();
    settle();
    expect(withSrc()).toHaveLength(2);
  });

  it('plays nothing with data saver on', () => {
    envState.saveData = true;
    addCards(3);
    on();
    settle();
    expect(videos()).toHaveLength(0);
  });

  it('pauses the clocks when the tab goes to the background and carries on when it is back', () => {
    addCards(2);
    on();
    settle();
    pause.mockClear();
    play.mockClear();
    envState.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pause).toHaveBeenCalledTimes(2);
    expect(withSrc()).toHaveLength(2);
    envState.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('starts paused when it is built in a background tab', () => {
    pool.dispose();
    envState.hidden = true;
    pool = make();
    addCards(1);
    on();
    settle();
    expect(pause).toHaveBeenCalled();
  });

  it('lets go of every stream while paused (a viewer is open), and brings them back after', () => {
    addCards(4);
    on();
    settle();
    pool.setPaused(true);
    fadeOut();
    expect(withSrc()).toHaveLength(0);
    expect(pool.playingIds.size).toBe(0);
    pool.setPaused(false);
    settle();
    expect(withSrc()).toHaveLength(4);
  });
});

describe('AmbientVideos: with the hover overlay', () => {
  it('covers a playing card when muted, not when sound is on', () => {
    addCards(2);
    on({ muted: true });
    settle();
    expect(pool.covers('c000')).toBe(true);
    expect(pool.covers('nope')).toBe(false);
    on({ muted: false });
    expect(pool.covers('c000')).toBe(false);
  });

  it('lets go of the card the hover overlay plays (one card is never two streams)', () => {
    addCards(3);
    on({ muted: false });
    settle();
    expect(withSrc()).toHaveLength(3);
    pool.exclude('c001');
    expect(pool.isPlaying('c001')).toBe(false);
    fadeOut();
    expect(srcs()).toEqual(['/media/0.mp4', '/media/2.mp4']);
    pool.exclude(null);
    settle();
    expect(pool.isPlaying('c001')).toBe(true);
  });

  it('tells the host when the set of playing cards changes', () => {
    addCards(2);
    on();
    settle();
    expect(changes).toBeGreaterThan(0);
    const n = changes;
    pool.settle();
    expect(changes).toBe(n);
  });
});

describe('AmbientVideos: teardown', () => {
  it('removes its elements', () => {
    addCards(3);
    on();
    settle();
    pool.dispose();
    expect(videos()).toHaveLength(0);
  });
});
