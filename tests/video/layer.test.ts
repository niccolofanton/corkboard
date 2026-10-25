// @vitest-environment jsdom
// The video layer against a real Store and a stub stage: how pause, mute and the tab's visibility reach the
// hover / selection overlay. The playing machinery itself is covered in video / ambient / videoController.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createElement } from '../../src/model';
import type { Stage } from '../../src/render/stage';
import { Store } from '../../src/store';
import { FADE_OUT_MS } from '../../src/video/video';
import { VideoLayer, type VideoOptions } from '../../src/video/layer';

const VIEW = { w: 1600, h: 1000 };

function fakeStage(): Stage {
  const cam = { tx: 0, ty: 0, scale: 1 };
  return {
    cam: { cam, scale: 1, width: VIEW.w, height: VIEW.h },
    previewRectOf: () => undefined,
  } as unknown as Stage;
}

let play: MockInstance<() => Promise<void>>;
let pause: MockInstance<() => void>;
let parent: HTMLElement;
let root: HTMLElement;
let layer: VideoLayer | null;
let visibility: DocumentVisibilityState;

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom implements no media playback.
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  parent = document.createElement('div');
  root = document.createElement('div');
  parent.appendChild(root);
  document.body.appendChild(parent);
  layer = null;
});

afterEach(() => {
  layer?.dispose();
  parent.remove();
  // Back to the real getter, on the prototype.
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const card = (id = 'v1') =>
  createElement({ x: 0, y: 0, w: 400, h: 300, media: { src: 'poster.jpg', video: `/media/${id}.mp4` } }, id);

function make(options: VideoOptions = {}) {
  const store = new Store();
  store.add([card()]);
  layer = new VideoLayer({ root, store, stage: fakeStage() }, options);
  return { store, layer };
}

// The hover / selection overlay's <video> (the pool's are inside a world layer of their own).
const overlayVideo = (): HTMLVideoElement => {
  const host = [...root.children].find((c) => (c as HTMLElement).style.display === 'contents');
  return host?.querySelector('video') as HTMLVideoElement;
};
const fadeOut = (): void => void vi.advanceTimersByTime(FADE_OUT_MS + 40);

describe('VideoLayer pause', () => {
  it('stays paused when the options change: `video.setOptions` does not un-pause the overlay', () => {
    const { layer } = make({ mode: 'hover' });
    layer.setSelection(['v1']);
    expect(layer.playing.has('v1')).toBe(true);

    layer.setPaused(true);
    fadeOut();
    expect(layer.playing.size).toBe(0);

    // Any later option change used to re-enable the controller, and the selected card played again.
    layer.setOptions({ loop: false });
    layer.setOptions({ mode: 'hover' });
    layer.setOptions({ muted: false });
    fadeOut();
    expect(layer.playing.size).toBe(0);
    layer.setSelection([]);
    layer.setSelection(['v1']);
    expect(layer.playing.size).toBe(0);

    layer.setPaused(false);
    expect(layer.playing.has('v1')).toBe(true);
  });

  it('stays paused when the mode switches back from off', () => {
    const { layer } = make({ mode: 'off' });
    layer.setPaused(true);
    layer.setSelection(['v1']);
    layer.setOptions({ mode: 'hover' });
    expect(layer.playing.size).toBe(0);
    layer.setPaused(false);
    expect(layer.playing.has('v1')).toBe(true);
  });
});

describe('VideoLayer mute', () => {
  it('a selected card the pool plays muted starts playing with sound when muted turns off', () => {
    const { layer } = make({ mode: 'always', muted: true });
    layer.setSelection(['v1']);
    // The pool plays it, muted, and covers it: the overlay has nothing to add.
    expect(layer.playing.has('v1')).toBe(true);
    expect(overlayVideo().style.display).toBe('none');

    layer.setOptions({ muted: false });
    const v = overlayVideo();
    expect(v.style.display).toBe('block');
    expect(v.getAttribute('src')).toBe('/media/v1.mp4');
    expect(v.muted).toBe(false);
  });
});

describe('VideoLayer visibility', () => {
  const hide = (): void => {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const show = (): void => {
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('pauses the hover / selection overlay in a background tab and carries on when it is back', () => {
    const { layer } = make({ mode: 'hover', muted: false });
    layer.setSelection(['v1']);
    expect(layer.playing.has('v1')).toBe(true);
    pause.mockClear();
    play.mockClear();

    hide();
    expect(pause).toHaveBeenCalledTimes(1);
    // The card stays where it is: it is paused, not torn down.
    expect(layer.playing.has('v1')).toBe(true);
    expect(overlayVideo().getAttribute('src')).toBe('/media/v1.mp4');

    show();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('keeps a card that starts in the background tab paused', () => {
    const { layer } = make({ mode: 'hover', muted: false });
    hide();
    play.mockClear();
    pause.mockClear();
    layer.setSelection(['v1']);
    expect(layer.playing.has('v1')).toBe(true);
    // Whatever play() did, the overlay was paused straight after.
    expect(pause).toHaveBeenCalled();
    expect(pause.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(play.mock.invocationCallOrder.at(-1)!);
  });

  it('starts hidden when the tab is already in the background', () => {
    visibility = 'hidden';
    const { layer } = make({ mode: 'hover' });
    layer.setSelection(['v1']);
    expect(pause).toHaveBeenCalled();
    pause.mockClear();
    show();
    expect(play).toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('stops listening on dispose', () => {
    const { layer } = make({ mode: 'hover' });
    layer.setSelection(['v1']);
    layer.dispose();
    pause.mockClear();
    play.mockClear();
    hide();
    show();
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });
});

describe('VideoLayer errors', () => {
  it('reports a <video> that failed to load once per card and file, with the card and the URL', () => {
    const onError = vi.fn();
    const store = new Store();
    store.add([card()]);
    layer = new VideoLayer({ root, store, stage: fakeStage(), onError }, { mode: 'hover' });
    layer.setSelection(['v1']);
    const v = overlayVideo();
    v.dispatchEvent(new Event('error'));
    v.dispatchEvent(new Event('error'));
    expect(onError).toHaveBeenCalledTimes(1);
    const e = onError.mock.calls[0][0];
    expect(e).toMatchObject({ kind: 'video', id: 'v1', url: '/media/v1.mp4' });
    expect(e.cause).toBeDefined();
  });

  it('ignores an error that comes after the card let go of its file', () => {
    const onError = vi.fn();
    const store = new Store();
    store.add([card()]);
    layer = new VideoLayer({ root, store, stage: fakeStage(), onError }, { mode: 'hover' });
    layer.setSelection(['v1']);
    const v = overlayVideo();
    layer.setSelection([]);
    fadeOut();
    v.dispatchEvent(new Event('error'));
    expect(onError).not.toHaveBeenCalled();
  });
});
