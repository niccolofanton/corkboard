// The video overlay: ONE looping <video> laid over the video card that currently plays. It is
// transform-synced from the render loop: `sync` and `follow` write only `transform` (and the size when
// the card was resized); source and clip change in `show`.
//
// It must cover exactly the card, so it FOLLOWS it: the host calls `follow` every frame with the card's
// current rect (the live drag / resize / rotate preview, else the stored one), because a card can move
// while it plays: it is dragged or resized, an edit is undone, another client moves it. Where the box
// lands is `videoPlacement` (videoGeometry.ts), rotation included.
//
// The card's own thumbnail (drawn by WebGL, underneath) is the poster. The <video> is transparent until a
// frame of it is on screen, then fades in over the thumbnail (reveal.ts: data-state / data-busy on the
// overlay's host, the look in the injected `.cb-*` styles). It fills the card's box the way the sprite
// does (`object-fit: cover`: the thumbnail is cropped to the card's shape, centred, never stretched), so
// the two are one picture and the fade shows no jump. While the picture a card was asked for is not there (loading, or stalled mid-way) a ring spins
// over its centre after INDICATOR_DELAY_MS, so a cached video never flashes it. Stopping fades back to
// the thumbnail first, and only then lets go of the network.
import type { Box, Camera } from '../math';
import {
  attachVideoReveal,
  buildRevealSpinner,
  INDICATOR_DELAY_MS,
  type VideoReveal,
} from './reveal';
import { videoPlacement, type VideoRect } from './videoGeometry';

export interface VideoTarget {
  id: string;
  src: string;
  // The card's {@link Box}, in world px.
  box: Box;
  // Degrees; the card rotates about the centre of its box.
  rot?: number;
  // World px. Applied as `clip-path: inset(0 round R)` in the video's own (world) space, so the
  // transform scales the corners with the card.
  radius: number;
}

// A wait shorter than this shows no ring: it would be a blink, not information.
export const SPINNER_DELAY_MS = INDICATOR_DELAY_MS;
// The fade back to the thumbnail (`--cb-out` in reveal.ts) and a margin: the network is let go after it.
export const FADE_OUT_MS = 150;
const HIDE_DELAY_MS = FADE_OUT_MS + 30;
// The ring's disc (`.cb-spinner` in reveal.ts), to centre it on the card.
const DISC_PX = 52;

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface VideoOverlayOptions {
  // The buffering ring over the card (default on). The ambient pool turns it off: a dozen cards
  // loading at once would be a dozen spinners.
  spinner?: boolean;
  // The element is placed in WORLD space, inside a parent that carries the camera's transform (the
  // ambient pool: one transform per frame for the whole screenful, instead of one per video). Then
  // `sync` has nothing to do and `follow` only writes when the card itself moved.
  worldSpace?: boolean;
  // `nonce` of the injected <style> (a CSP with a nonce-based `style-src`).
  nonce?: string;
  // The file of the current card failed to load (the element's `error` event).
  onError?: (target: { id: string; src: string }, cause: unknown) => void;
}

// What a world-space overlay is placed with: the camera's identity (the parent has the real one).
const WORLD_CAMERA: Camera = { tx: 0, ty: 0, scale: 1 };

export class VideoOverlay {
  private readonly video: HTMLVideoElement;
  // Carries data-state / data-busy (reveal.ts); `display: contents`, it has no box of its own.
  private readonly host: HTMLElement;
  private readonly disc: HTMLElement;
  private readonly reveal: VideoReveal;
  private readonly worldSpace: boolean;
  private target: VideoTarget | null = null;
  private rect: VideoRect = { x: 0, y: 0, w: 0, h: 0, rot: 0 };
  // The sound switch (setPlayback); the element itself may be muted for one card (play()).
  private wantMuted = true;
  private wroteTransform = '';
  private wroteDisc = '';
  private wroteW = NaN;
  private wroteH = NaN;
  // Stopped, and fading back to the thumbnail: the source and the box stay until the fade is done.
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(root: HTMLElement, opts: VideoOverlayOptions = {}) {
    const doc = root.ownerDocument;
    this.worldSpace = opts.worldSpace === true;
    const host = doc.createElement('div');
    host.style.display = 'contents';
    const v = doc.createElement('video');
    v.className = 'cb-video';
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'metadata';
    // Attributes too: iOS Safari and the autoplay policy read the markup form.
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('loop', '');
    v.setAttribute('disablepictureinpicture', '');
    // Many CSS resets set `max-width: 100%` / `height: auto` on every <video>: left alone they would clamp
    // a card wider than the viewport (zoomed in) to the viewport's width, and the box would no longer be
    // the card's.
    v.style.cssText =
      'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;' +
      'max-width:none;max-height:none;object-fit:cover;display:none;';

    // The ring stays upright and the same size on screen, centred on the card: placed by `transform`.
    const disc = buildRevealSpinner(doc);
    disc.style.cssText =
      'position:absolute;left:0;top:0;' + (opts.spinner === false ? 'display:none;' : '');

    host.append(v, disc);
    root.append(host);
    this.video = v;
    this.host = host;
    this.disc = disc;
    this.reveal = attachVideoReveal(v, { host, nonce: opts.nonce });
    const onError = opts.onError;
    if (onError) {
      v.addEventListener('error', (e) => {
        // The error of a source we dropped (teardown) is not the card's.
        const t = this.target;
        if (!t || this.disposed || v.getAttribute('src') !== t.src) return;
        onError({ id: t.id, src: t.src }, v.error ?? e);
      });
    }
  }

  // Playback switches. Applied at once and kept for every later card.
  setPlayback(o: { loop: boolean; muted: boolean }): void {
    const v = this.video;
    v.loop = o.loop;
    v.muted = o.muted;
    this.wantMuted = o.muted;
    if (o.loop) v.setAttribute('loop', '');
    else v.removeAttribute('loop');
    if (o.muted) v.setAttribute('muted', '');
    else v.removeAttribute('muted');
  }

  get activeId(): string | null {
    return this.target?.id ?? null;
  }

  // The file the element has loaded (null when idle).
  get activeSrc(): string | null {
    return this.target !== null ? this.video.getAttribute('src') : null;
  }

  // The tab went to the background: the clock stops, the element and its place stay.
  suspend(): void {
    if (!this.target) return;
    try {
      this.video.pause();
    } catch {
      // Not implemented (jsdom).
    }
  }

  // The tab is back: carry on from where it stopped.
  resume(): void {
    if (this.disposed || !this.target || this.hideTimer !== null) return;
    this.play();
  }

  // `load: false` is the hover delay: the card is asked for but not fetched yet. Nothing is shown, the ring
  // already counts its wait; `show` (load) follows when the delay is over, `hide` if the hover ended.
  show(target: VideoTarget, camera: Camera, load = true): void {
    if (this.disposed) return;
    const v = this.video;
    if (this.hideTimer !== null) {
      // Back while it was fading out: the same card carries on from where it is; another one starts clean.
      if (this.target !== null && v.getAttribute('src') === target.src) this.cancelHide();
      else this.teardown();
    }
    const sameSource = this.target !== null && v.getAttribute('src') === target.src;
    this.target = target;
    this.rect = { ...target.box, rot: target.rot ?? 0 };
    // A new picture is coming: the card shows through until its first frame (the reveal resets on
    // `loadstart`).
    if (load && !sameSource) {
      // A card muted after a refused autoplay (play()) does not carry that to the next one.
      v.muted = this.wantMuted;
      v.src = target.src;
    }
    v.style.clipPath = `inset(0 round ${round3(target.radius)}px)`;
    v.style.display = 'block';
    this.writeSize();
    this.wroteTransform = '';
    this.wroteDisc = '';
    this.writeTransform(camera);
    this.reveal.request();
    if (load) this.play();
  }

  // Transform only (the camera moved).
  sync(camera: Camera): void {
    if (this.disposed || !this.target || this.worldSpace) return;
    this.writeTransform(camera);
  }

  // The card's box changed (dragged, resized, rotated, undone, moved by a peer): the overlay goes with
  // it. Returns whether the SIZE changed (the card may have become too small to play).
  follow(rect: VideoRect, camera: Camera): boolean {
    if (this.disposed || !this.target) return false;
    const r = this.rect;
    const rot = rect.rot ?? 0;
    const resized = rect.w !== r.w || rect.h !== r.h;
    r.x = rect.x;
    r.y = rect.y;
    r.w = rect.w;
    r.h = rect.h;
    r.rot = rot;
    if (resized) this.writeSize();
    this.writeTransform(camera);
    return resized;
  }

  // Fades back to the thumbnail (the card keeps playing under the fade), then releases the network.
  hide(): void {
    if (this.disposed || !this.target || this.hideTimer !== null) return;
    this.reveal.release();
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) this.teardown();
    else this.hideTimer = setTimeout(() => this.teardown(), HIDE_DELAY_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.teardown();
    this.disposed = true;
    this.reveal.dispose();
    this.host.remove();
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  // Pause, drop the source and reload the empty element (the documented way to make the browser abort
  // the download).
  private teardown(): void {
    this.cancelHide();
    if (!this.target) return;
    this.target = null;
    this.reveal.release();
    const v = this.video;
    try {
      v.pause();
    } catch {
      // Not implemented (jsdom) or already detached: nothing to stop.
    }
    if (v.hasAttribute('src')) {
      v.removeAttribute('src');
      try {
        v.load();
      } catch {
        // Same as above.
      }
    }
    v.style.display = 'none';
  }

  // The <video> is laid out at the card's world size; the transform scales it to the screen.
  private writeSize(): void {
    const { w, h } = this.rect;
    if (w !== this.wroteW) {
      this.video.style.width = `${round3(w)}px`;
      this.wroteW = w;
    }
    if (h !== this.wroteH) {
      this.video.style.height = `${round3(h)}px`;
      this.wroteH = h;
    }
  }

  private writeTransform(cam: Camera): void {
    if (!this.target) return;
    const camera = this.worldSpace ? WORLD_CAMERA : cam;
    const p = videoPlacement(this.rect, camera);
    if (p.transform !== this.wroteTransform) {
      this.wroteTransform = p.transform;
      this.video.style.transform = p.transform;
    }
    // The ring belongs to the screen (upright, one size): a world-space overlay has none.
    if (this.worldSpace) return;
    const disc = `translate(${round3(p.cx - DISC_PX / 2)}px, ${round3(p.cy - DISC_PX / 2)}px)`;
    if (disc !== this.wroteDisc) {
      this.wroteDisc = disc;
      this.disc.style.transform = disc;
    }
  }

  // Autoplay can be refused (no user gesture yet, data saver) or aborted by a quick hide(): both are
  // routine, so the rejection is swallowed.
  // A video that keeps its sound is refused unmuted autoplay until the page has had a gesture (and on
  // iOS almost always): the card would stay on its thumbnail. Then it plays muted for this card, and the
  // next card tries with sound again.
  private play(): void {
    const v = this.video;
    const target = this.target;
    try {
      const p: Promise<void> | undefined = v.play();
      p?.catch((e: unknown) => {
        if (v.muted || (e as { name?: string } | null)?.name !== 'NotAllowedError') return;
        // Hidden or moved to another card meanwhile: that one asks for itself.
        if (this.target !== target || target === null) return;
        v.muted = true;
        v.play()?.catch(() => {});
      });
    } catch {
      // Not implemented (jsdom).
    }
  }
}
