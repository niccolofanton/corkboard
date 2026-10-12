// How a video comes in over its picture, one behaviour for every video. The controller reads the media
// element's events and writes two attributes on a HOST element (by default the video's parent); the look
// is CSS (injected once by `injectRevealStyles`), so nothing re-renders and nothing runs per frame.
//
//   data-state  poster   the picture shows (not asked for, hovered out, or the file failed)
//               loading  asked for, and no frame of it has been PRESENTED yet: the picture stays
//               playing  a frame is on screen: the video fades in over the picture (also paused)
//               stalled  it ran dry mid-play: the last frame stays, no fall back to the picture
//   data-busy   "true" once `loading` or `stalled` has lasted INDICATOR_DELAY_MS: the buffering ring
//               shows (a wait shorter than that would be a blink, not information)
//
// "A frame is on screen" is `requestVideoFrameCallback` where the browser has it (the frame was handed to
// the compositor, so the fade starts on a picture and never on a black or empty box); else `playing` once
// the clock has moved. A safety timer covers a browser that never calls back (a hidden tab).

const STYLE_ATTR = 'data-corkboard-video';

// In: the first frame over the picture. Out: back to the picture. The ring is a ring on a soft disc, so it
// reads on any picture; its colours belong to the media, not to a page theme.
const CSS = `
.cb-video{opacity:0;--cb-in:240ms;--cb-out:150ms;--cb-ease:cubic-bezier(0.2,0,0,1);--cb-dur:var(--cb-out);transition:opacity var(--cb-dur) var(--cb-ease)}
[data-state='playing'] .cb-video,[data-state='stalled'] .cb-video{opacity:1;--cb-dur:var(--cb-in)}
.cb-spinner{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:50%;background:rgb(0 0 0 / 0.4);opacity:0;pointer-events:none;transition:opacity 160ms ease}
.cb-ring{box-sizing:border-box;width:36px;height:36px;border-radius:50%;border:2px solid transparent;border-color:rgb(255 255 255 / 0.25);border-top-color:rgb(255 255 255 / 0.8);animation:cb-spin 800ms linear infinite;animation-play-state:paused}
[data-busy='true'] .cb-spinner{opacity:1}
[data-busy='true'] .cb-ring{animation-play-state:running}
@keyframes cb-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.cb-video,.cb-spinner{transition:none}.cb-ring{animation:none}}
`;

// Appends the stylesheet to the document's <head> the first time it is needed (idempotent).
export function injectRevealStyles(doc: Document = document): void {
  const head = doc.head;
  if (!head || head.querySelector(`style[${STYLE_ATTR}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = CSS;
  head.appendChild(style);
}

export type RevealState = 'poster' | 'loading' | 'playing' | 'stalled';

// A wait shorter than this shows no ring.
export const INDICATOR_DELAY_MS = 250;
// `playing` with no frame callback after this long: take the frame as presented. The callback of a
// browser that has one follows `playing` by a frame or two, so its safety net is far slower.
const FALLBACK_MS = 120;
const FALLBACK_RVFC_MS = 600;
// HAVE_CURRENT_DATA / HAVE_FUTURE_DATA of the media element.
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

const EVENTS = [
  'loadstart',
  'emptied',
  'loadeddata',
  'playing',
  'waiting',
  'stalled',
  'canplay',
  'seeked',
  'timeupdate',
  'error',
] as const;

export interface VideoRevealOptions {
  // Carries data-state and data-busy. Default: the video's parent. Its CSS (`.cb-video`, `.cb-spinner`)
  // applies to the descendants.
  host?: HTMLElement | null;
  // Called when the state changes (a card that also wants it in React state; at most a few times a hover).
  onState?: (state: RevealState) => void;
}

export interface VideoReveal {
  readonly state: RevealState;
  // The video is wanted (a hover began, play was pressed): from now on its first frame fades in.
  request(): void;
  // It is not (hovered out, stopped): back to the picture.
  release(): void;
  dispose(): void;
}

export function attachVideoReveal(
  video: HTMLVideoElement,
  opts: VideoRevealOptions = {},
): VideoReveal {
  const v = video;
  injectRevealStyles(v.ownerDocument);
  const host = opts.host === undefined ? video.parentElement : opts.host;
  // Older browsers (and jsdom) have no frame callbacks; the types say every one does.
  const hasRvfc = typeof v.requestVideoFrameCallback === 'function';
  let wanted = false;
  let frame = false;
  let stalled = false;
  let failed = false;
  let state: RevealState = 'poster';
  let busy = false;
  let disposed = false;
  // Bumped when the source changes or the controller lets go: a callback of an older one is ignored.
  let generation = 0;
  let rvfc: number | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  let busyTimer: ReturnType<typeof setTimeout> | null = null;

  const write = (): void => {
    if (!host) return;
    if (host.dataset.state !== state) host.dataset.state = state;
    if (busy) {
      if (host.dataset.busy !== 'true') host.dataset.busy = 'true';
    } else if (host.hasAttribute('data-busy')) host.removeAttribute('data-busy');
  };

  const compute = (): void => {
    if (disposed) return;
    const next: RevealState =
      !wanted || failed ? 'poster' : !frame ? 'loading' : stalled ? 'stalled' : 'playing';
    const waiting = next === 'loading' || next === 'stalled';
    if (next !== state) {
      state = next;
      opts.onState?.(state);
    }
    if (!waiting) {
      if (busyTimer !== null) clearTimeout(busyTimer);
      busyTimer = null;
      busy = false;
    } else if (!busy && busyTimer === null) {
      busyTimer = setTimeout(() => {
        busyTimer = null;
        busy = true;
        write();
      }, INDICATOR_DELAY_MS);
    }
    write();
  };

  const clearFrameWatch = (): void => {
    if (rvfc !== null) v.cancelVideoFrameCallback?.(rvfc);
    rvfc = null;
    if (fallback !== null) clearTimeout(fallback);
    fallback = null;
  };

  const setFrame = (): void => {
    if (frame) return;
    frame = true;
    clearFrameWatch();
    compute();
  };

  // `playing` with no frame callback yet: the safety net that takes the frame as presented. Some browsers
  // never call back for a video that is still transparent (iOS Safari does not composite it), so this is
  // armed whenever a wanted video is seen playing, whatever came first: the event or the request.
  const armFallback = (): void => {
    if (frame || !wanted || fallback !== null) return;
    const gen = generation;
    fallback = setTimeout(
      () => {
        fallback = null;
        if (gen === generation && wanted && !v.paused) setFrame();
        // Paused when it fired (a moment off screen): the next `playing` or clock tick arms it again.
      },
      hasRvfc ? FALLBACK_RVFC_MS : FALLBACK_MS,
    );
  };

  // Watches for the first presented frame of the source that is loading now.
  const watchFrame = (): void => {
    if (!wanted || frame || !hasRvfc || rvfc !== null) return;
    const gen = generation;
    rvfc = v.requestVideoFrameCallback(() => {
      rvfc = null;
      if (gen === generation && wanted) setFrame();
    });
  };

  const reset = (): void => {
    generation++;
    frame = false;
    stalled = false;
    failed = false;
    clearFrameWatch();
    watchFrame();
    compute();
  };

  const onEvent = (e: Event): void => {
    if (disposed) return;
    switch (e.type) {
      case 'loadstart':
      case 'emptied':
        // A new source (or none): whatever frame there was is gone.
        reset();
        break;
      case 'error':
        failed = true;
        compute();
        break;
      case 'playing':
        stalled = false;
        if (!frame) {
          if (!hasRvfc && v.currentTime > 0) setFrame();
          else armFallback();
        }
        compute();
        break;
      case 'timeupdate':
        // No frame callbacks: the clock moving is the sign of a frame.
        if (!frame && wanted && !v.paused && v.currentTime > 0) {
          if (!hasRvfc) setFrame();
          // The clock moves and no frame was called back: the `playing` may have come before the request.
          else armFallback();
        } else if (stalled && v.readyState >= HAVE_FUTURE_DATA) {
          stalled = false;
          compute();
        }
        break;
      case 'waiting':
      case 'stalled':
        if (frame && v.readyState < HAVE_FUTURE_DATA) {
          stalled = true;
          compute();
        }
        break;
      case 'canplay':
      case 'seeked':
        if (stalled && v.readyState >= HAVE_FUTURE_DATA) {
          stalled = false;
          compute();
        }
        break;
      default:
        break;
    }
  };
  for (const type of EVENTS) v.addEventListener(type, onEvent);
  write();

  return {
    get state() {
      return state;
    },
    request() {
      if (disposed) return;
      wanted = true;
      // A new `src` empties the element at once: a frame from before it is not one of this source.
      if (v.readyState < HAVE_CURRENT_DATA) {
        frame = false;
        stalled = false;
      }
      failed = !!v.error;
      watchFrame();
      // Asked for while it already plays (its `playing` came first): the safety net starts now.
      if (!v.paused && v.readyState >= HAVE_CURRENT_DATA) armFallback();
      compute();
    },
    release() {
      if (disposed) return;
      wanted = false;
      generation++;
      clearFrameWatch();
      compute();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      clearFrameWatch();
      if (busyTimer !== null) clearTimeout(busyTimer);
      busyTimer = null;
      for (const type of EVENTS) v.removeEventListener(type, onEvent);
      if (host) {
        delete host.dataset.state;
        delete host.dataset.busy;
      }
    },
  };
}

// The buffering ring (a disc and a ring in it), for the code that builds its DOM by hand. It shows while
// the host's data-busy is "true".
export function createRevealSpinner(doc: Document): HTMLElement {
  injectRevealStyles(doc);
  const disc = doc.createElement('span');
  disc.className = 'cb-spinner';
  disc.setAttribute('aria-hidden', 'true');
  const ring = doc.createElement('span');
  ring.className = 'cb-ring';
  disc.appendChild(ring);
  return disc;
}
