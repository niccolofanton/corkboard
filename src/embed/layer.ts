// The embed layer of a corkboard: poster resolution and the live iframes of `embed` cards.
//
//   poster   always. The card is a textured sprite like any other (generated tile, provider thumbnail or
//            the host's picture), through the LOD pipeline. No DOM.
//   live     an iframe in a DOM layer over the canvas, laid out at the card's world size and moved with the
//            camera as one CSS matrix (geometry.ts), for the cards the policy picks (policy.ts):
//            in view (any size, any zoom, by default) or selected, camera still, at most `maxLive` at a time. The poster stays under it,
//            veiled with a spinner, and the iframe fades in when it has loaded.
//   parked   a live iframe that stopped qualifying (too small, zoomed out, off screen, or out of the `maxLive`
//            budget) but stays mounted and inert (`data-parked`), still showing its last frame: a cross-origin
//            page cannot be screenshotted, so the poster would be a downgrade. At most `maxMounted` frames
//            (live + parked) exist; the least valuable parked ones are destroyed past that, and only then does
//            the poster show again. A parked card that qualifies again goes live without remounting.
//   culled   a mounted frame whose card is off screen (the viewport grown by CULL_MARGIN): `data-culled`,
//            `display: none`, so it stops rendering while its document stays alive and comes back as it was. Set
//            in `place()` on every frame, even mid-pan: frames hide the moment they leave and show the moment
//            they return. At most `maxOffscreen` are kept, most recently seen first; the plan destroys the rest
//            when the camera settles, and a destroyed card that returns mounts again through the chunked path.
//            A loaded snippet frame is the exception on the way out: hiding it first would leave nothing to
//            snapshot (no layout, no size), so it is asked for a snapshot of its last frame, which becomes the
//            card's poster (`data-culling`, still visible but off screen), and is hidden when the reply is in or
//            after CULL_SNAPSHOT_MS. That costs main-thread work in the frame, so it is throttled (one per frame
//            per CULL_SNAPSHOT_MIN_MS) and never takes the slots freezing needs. On the way back the frame is
//            transparent until it has painted (`data-revealing`), so the poster shows instead of a white box: a
//            snippet says so itself (bootstrap.ts, `show` / `painted`), any other page is given REVEAL_MS. The
//            same goes for every other way a frame becomes visible: its first load and a frozen frame thawing.
//   frozen   a snippet frame whose card is small on screen (under `freezePx`) and idle: it is asked for a
//            snapshot of its own document (bootstrap.ts), the picture becomes the card's poster, and once that
//            texture shows the frame is hidden (`data-frozen`, `display: none`, so it stops rendering while its
//            document stays alive). It keeps its place in the live / parked budgets, and shows again the moment
//            the card grows past 1.4x `freezePx`, is selected or enters interact mode. A snapshot that fails
//            (a tainted canvas, Safari, a timeout) leaves the frame live: never a generic tile for a card that
//            has been live. The poster that is left is the last frame, which is also what shows if the frame
//            is destroyed later.
//   Life of a card: poster -> live -> parked -> culled -> destroyed (back to its poster).
//   pause    work no one sees is stopped without destroying anything. A snippet frame that is parked, culled
//            or frozen gets `pause` (animations paused, requestAnimationFrame held) and `resume` when it is
//            active again. A YouTube / Vimeo frame is paused through its player's postMessage API while its
//            card is small, parked or culled (a paused player keeps showing the current video frame, which is
//            the "last frame" a cross-origin page cannot be snapshotted to), and played again afterwards if
//            this layer paused it. Only on a change of state; never in interact mode.
//   budget   what is left to render is bounded too. Of the mounted frames that are on screen, not culled, not
//            parked and not frozen, the ones that can be paused (snippets, and YouTube / Vimeo players that may be
//            playing) are ranked: interacting, selected, then the biggest on screen, then the nearest the centre
//            of the view. The first N animate and the rest are paused (and resumed on re-entering), still showing
//            their last frame. N is `maxAnimating` at most, and with `adaptive` a rAF sampler (only while
//            something visible renders) lowers it when the page runs under SLOW_FPS and raises it back when it
//            is smooth. Pages that cannot be paused (plain URLs, Spotify, CodePen, Figma) take no slot and are
//            never touched. Ranked on settle and on selection, interaction or budget changes, not every frame.
//            Mounting is not affected: every card in view still mounts.
//   interact the iframe takes pointer events (double-click or Enter on a selected embed). A "Done" button,
//            a click outside the iframe or Esc ends it. Until then the canvas keeps pan, zoom, select and
//            drag: the iframe has `pointer-events: none`.
//
// What goes in the iframe (sandbox, allow list) is decided at mount time by sandbox.ts, never stored.
import type { Camera } from '../math';
import type { Stage } from '../render/stage';
import type { MediaView } from '../render/views/mediaView';
import type { Store, StoreEvent } from '../store';
import type { Theme } from '../render/theme';
import { elementBox } from '../interact/geometry';
import type { Element, ElementId, EmbedResolution, EmbedSource } from '../types';
import { DEFAULT_RESOLUTION, embedPlacement } from './geometry';
import {
  MAX_LIVE_DESKTOP,
  MAX_LIVE_TOUCH,
  MAX_MOUNTED_DESKTOP,
  MAX_MOUNTED_TOUCH,
  MAX_OFFSCREEN_DESKTOP,
  MAX_OFFSCREEN_TOUCH,
  MIN_LIVE_H,
  MIN_LIVE_SCALE,
  MIN_LIVE_W,
  planLive,
  type PolicyCard,
} from './policy';
import { fetchPoster } from './poster';
import { withAutoplay, withJsApi, type EmbedProvider } from './providers';
import {
  baseResolved,
  canGoLive,
  mergeResolved,
  sameEmbed,
  type EmbedResolver,
  type ResolvedEmbed,
} from './resolve';
import { EMBED_CB, SNAPSHOT_MAX_SIDE, SNAPSHOT_MS } from './bootstrap';
import { iframeSpecFor, type IframeSpec } from './sandbox';
import { drawTile, tileSpec } from './tile';

export interface EmbedOptions {
  // Live iframes at once on a mouse / pen device (default 12). Infinity: no cap.
  maxLive?: number;
  // ... and on a touch device (default 3). Infinity: no cap.
  maxLiveTouch?: number;
  // Mounted iframes at once, live + parked, on a mouse / pen device (default 24). Infinity: no cap.
  maxMounted?: number;
  // ... and on a touch device (default 6). Infinity: no cap.
  maxMountedTouch?: number;
  // Mounted iframes kept while their card is off screen (culled: hidden, not rendering, but alive), a subset of
  // maxMounted, on a mouse / pen device (default 64). The most recently seen stay; the rest are destroyed
  // when the camera settles. Infinity: only maxMounted limits them.
  maxOffscreen?: number;
  // ... and on a touch device (default 12). Infinity: only maxMounted limits them.
  maxOffscreenTouch?: number;
  // How far past the viewport a card still counts as on screen, as a fraction of the viewport on each side
  // (default CULL_MARGIN). Frames in that ring keep rendering, and cards entering it mount ahead of the pan.
  cullMargin?: number;
  // A card goes live when it is at least this big on screen, in CSS px, or selected. Default 0: any card in
  // view, up to `maxLive`, the biggest on screen first. A number is the width; the height keeps a 320:200 ratio.
  minLivePx?: number | { w: number; h: number };
  // Below this zoom no new iframe mounts (default 0: any zoom). Interacting still flies in to MIN_LIVE_SCALE.
  minLiveScale?: number;
  // Async lookup for what the browser cannot know: oEmbed thumbnails and titles, og:image, screenshots,
  // and whether the page may be framed at all. Runs on a server of yours. See EmbedResolver.
  resolve?: EmbedResolver;
  // Give up on `resolve` after this long and use what the URL says (default 4000 ms).
  resolveTimeoutMs?: number;
  // The virtual screen a live page is laid out at (default '720p'); a card's `embed.resolution` wins.
  resolution?: EmbedResolution;
  // Keep `allow-same-origin` in the sandbox of arbitrary (non-provider) URLs (default true). Many sites break
  // without their own cookies and storage, but the frame then keeps its real origin across the navigations
  // it makes. false: those frames get an opaque origin. Providers and snippets are not affected.
  arbitrarySameOrigin?: boolean;
  // Start YouTube and Vimeo videos playing on their own, muted and looping, as soon as their card goes live
  // (default false). Changing it remounts the live frames. Snippets run their own scripts either way.
  autoplay?: boolean;
  // Iframes loading at once (default 6). New frames mount in chunks, nearest the centre of the view first,
  // as earlier ones finish, so a board full of embeds does not start hundreds of pages in the same frame.
  // A frame that has not loaded after LOAD_SLOT_MS gives its slot up. Infinity: no limit.
  maxLoading?: number;
  // A mounted card whose short side on screen drops under this many CSS px is not worth rendering (default
  // 140). A snippet frame is frozen: it is snapshotted into the card's poster and hidden. A YouTube / Vimeo
  // frame is paused. Both come back above 1.4x this size, when selected or in interact mode. 0: neither
  // freezing nor size-based pausing (parked and culled frames are still paused).
  freezePx?: number;
  // At most this many mounted, visible frames that can be paused (snippets, YouTube / Vimeo) animate at once;
  // the rest are paused, showing their last frame, biggest on screen and nearest the centre first (default
  // Infinity). Pages that cannot be paused (plain URLs, Spotify, CodePen, Figma) are not counted.
  maxAnimating?: number;
  // Lower the number of animating frames while the page runs under 40 fps, and raise it back (up to
  // `maxAnimating`) when it is smooth again (default true). false: always `maxAnimating`.
  adaptive?: boolean;
}

export interface EmbedEvents {
  // Interact mode began (`active: true`) or ended on an embed card.
  embedInteract: { id: ElementId; active: boolean };
  // A card's iframe was mounted or destroyed.
  embedLive: { id: ElementId; live: boolean };
  // The card's embed was resolved. `poster` is a URL worth persisting (the host's own or a provider
  // thumbnail), absent for a generated tile or any blob URL this layer made (they die with the page).
  embedResolved: {
    id: ElementId;
    provider: EmbedProvider;
    frameable: boolean;
    aspect?: number;
    title?: string;
    poster?: string;
  };
}

export interface EmbedLayerDeps {
  // The DOM layer shared with the other overlays (covers the canvas, `pointer-events: none`).
  root: HTMLElement;
  // The board's host: Enter on it enters interact mode.
  host: HTMLElement;
  store: Store;
  stage: Stage;
  emit<K extends keyof EmbedEvents>(type: K, payload: EmbedEvents[K]): void;
  // The frame scheduler of the adaptive sampler (default: the window's). A seam for tests; the callback gets
  // the frame's timestamp, which is the only clock the sampler reads.
  raf?: (cb: (time: number) => void) => number;
  caf?: (id: number) => void;
  // Draws a snippet's snapshot (SVG markup, see bootstrap.ts) at w x h px (default: an <img> on a canvas). A
  // seam for tests, where nothing can rasterise.
  rasterize?: (svg: string, w: number, h: number) => Promise<Blob | null>;
}

interface Entry {
  embed: EmbedSource;
  info: ResolvedEmbed;
  // `resolve` has answered (or there is none): the card knows if it can go live.
  ready: boolean;
  // The title the resolver gave, kept for when the card's own title goes away.
  resolverTitle?: string;
  spec: IframeSpec | null;
  token: number;
  // The blob URL of the poster this layer made (photo or tile), written to media.src.
  ownUrl: string | null;
  ownKind: 'photo' | 'tile' | 'snapshot' | null;
  // Our earlier posters the element may still carry (the embed changed under it).
  stale: Set<string>;
  initialAspect: number;
  lastUsed: number;
  // Last time the card was on screen (inside the cull margin), from the same counter as lastUsed.
  lastSeen: number;
}

interface Frame {
  wrapper: HTMLElement;
  iframe: HTMLIFrameElement;
  loaded: boolean;
  // Holds a loading slot until it loads or LOAD_SLOT_MS passes.
  slot: boolean;
  slotTimer: ReturnType<typeof setTimeout> | null;
  w: number;
  h: number;
  transform: string;
  z: number;
  // Off screen. The wrapper is hidden (`data-culled`) at once, or when its last-frame snapshot is in (`cullTimer`).
  culled: boolean;
  // Waiting for the cull snapshot to hide the frame (`data-culling`).
  cullTimer: ReturnType<typeof setTimeout> | null;
  // When the last cull snapshot was asked for (Date.now()).
  cullSnapAt: number;
  // Back on screen and not painted yet: transparent (`data-revealing`) so the poster shows. `id` is what the
  // snippet's `painted` answers; the timer ends it anyway.
  reveal: { id: number; timer: ReturnType<typeof setTimeout> } | null;
  // Mirrors `data-parked`.
  parked: boolean;
  kind: 'snippet' | 'video' | 'page';
  provider: EmbedProvider;
  // Where a video player listens (its src origin).
  origin: string;
  // The card is under `freezePx` (with hysteresis) and idle.
  small: boolean;
  // Hidden by a snapshot (`data-frozen`).
  frozen: boolean;
  // The last snapshot failed: no new try until `retry` fires (SNAP_TRIES at most) or the card stops being small.
  snapFailed: boolean;
  snapTries: number;
  retry: ReturnType<typeof setTimeout> | null;
  // The request in flight, if any, and the size its picture is drawn at.
  // `cull`: asked because the card left the view, not to freeze it.
  snap: { id: number; timer: ReturnType<typeof setTimeout>; w: number; h: number; cull: boolean } | null;
  // Waiting for the snapshot poster to show before hiding the frame.
  landTimer: ReturnType<typeof setTimeout> | null;
  // Snippet: the last op sent (true: pause). Video: this layer paused the player.
  paused: boolean;
  // The user has had the frame in interact mode, so a video in it may be playing without autoplay.
  interacted: boolean;
  // Resends the video command once the player has had time to start listening.
  loadTimer: ReturnType<typeof setTimeout> | null;
  // Ranked past the animating budget: paused like a parked frame (never set on a frame that cannot be paused).
  overBudget: boolean;
}

// The rAF sampler behind `adaptive`.
interface Sampler {
  id: number;
  // Timestamp of the window's start and of the last frame (NaN: no frame yet), and frames since the start.
  start: number;
  last: number;
  frames: number;
  // The window in progress does not count (the first after a start, or one that followed a stall).
  discard: boolean;
  // Frame intervals of the window in progress: their fast end is the display's refresh rate.
  deltas: number[];
}

export const MAX_LOADING = 6;
export const LOAD_SLOT_MS = 8000;
// A card counts as on screen this far outside the viewport too (fraction of the viewport, each side), so frames
// just past the edge stay visible and a small pan does not hide and show them.
export const CULL_MARGIN = 0.5;
// Under this short side on screen (CSS px) a frame is frozen or paused, and above FREEZE_HYSTERESIS times it
// it comes back, so a card hovering around the size does not flip.
export const FREEZE_PX = 140;
export const FREEZE_HYSTERESIS = 1.4;
// Snapshots asked for at once: each is main-thread work in the frame.
export const MAX_SNAPSHOTS = 6;
// A frame that leaves the view is hidden once its snapshot is in, or this long after it was asked for.
export const CULL_SNAPSHOT_MS = 400;
// At most one such snapshot per frame in this time, so panning back and forth does not redo the work.
export const CULL_SNAPSHOT_MIN_MS = 3000;
// ... and only while this many of the MAX_SNAPSHOTS slots are free, so freezing is never starved.
const CULL_SNAPSHOT_RESERVE = 2;
// A returning frame that is not a snippet is transparent this long, a snippet until it says it painted or
// REVEAL_MAX_MS passes.
export const REVEAL_MS = 250;
export const REVEAL_MAX_MS = 800;
// A reply is awaited a bit longer than the frame's own time box.
const SNAPSHOT_WAIT_MS = SNAPSHOT_MS;
// A failed snapshot is tried again this much later (times the tries so far), this many times in all.
const SNAP_RETRY_MS = 2000;
const SNAP_TRIES = 3;
// After a snapshot poster is written: the first look at whether its texture shows, then every step, up to
// LAND_TRIES times. The stage forgets the old textures on the next frame, so a level read sooner is the old one.
const LAND_FIRST_MS = 200;
const LAND_STEP_MS = 100;
const LAND_TRIES = 30;
// The animating budget never adapts below this many frames.
export const MIN_ANIMATING = 6;
// fps is measured over windows this long; under SLOW_FPS the budget shrinks to 70% of what animates, and after
// SMOOTH_WINDOWS in a row over SMOOTH_FPS it grows by a quarter (+2). Both are for a 60 Hz display and scale
// down with the fastest window seen, so a 30 Hz (low power) screen is judged against its own rate.
export const SAMPLE_WINDOW_MS = 1000;
export const SLOW_FPS = 40;
export const SMOOTH_FPS = 55;
const REFERENCE_HZ = 60;
export const SMOOTH_WINDOWS = 2;
// A gap between two frames this long is a hidden or occluded page, not a slow one: the window is dropped.
const STALL_MS = 2500;
// A video player is sent its command again this long after the frame loaded (the first may be too early).
const PLAYER_READY_MS = 1500;

const STYLE_ID = 'cb-embed-styles';
const CSS = `
.cb-embed{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden;background:rgba(0,0,0,.28);pointer-events:none;container-type:size;transition:background-color .2s ease}
.cb-embed[data-ready]{background:#fff}
.cb-embed[data-ready][data-revealing]{background:transparent;transition:none}
.cb-embed[data-culled]{display:none}
.cb-embed iframe{position:absolute;left:0;top:0;width:100%;height:100%;border:0;display:block;pointer-events:none;color-scheme:normal;opacity:0;transition:opacity .2s ease}
.cb-embed[data-ready] iframe{opacity:1}
.cb-embed-spin{position:absolute;left:50%;top:50%;width:20cqmin;height:20cqmin;margin:-10cqmin 0 0 -10cqmin;border-radius:50%;background:rgba(16,17,20,.72);box-shadow:0 0 0 .4cqmin rgba(255,255,255,.18)}
.cb-embed-spin::after{content:'';position:absolute;inset:24%;box-sizing:border-box;border-radius:50%;border:1.6cqmin solid rgba(255,255,255,.25);border-top-color:#fff;animation:cb-embed-spin .9s linear infinite}
.cb-embed[data-ready] .cb-embed-spin{display:none}
@keyframes cb-embed-spin{to{transform:rotate(360deg)}}
.cb-embed[data-interact]{pointer-events:auto}
.cb-embed[data-interact] iframe{pointer-events:auto}
.cb-embed-done{position:absolute;left:0;top:0;z-index:2147483647;pointer-events:auto;font:600 12px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff;background:rgba(20,20,22,.9);border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:8px 14px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);display:none}
.cb-embed-done:hover{background:rgba(48,48,52,.95)}
.cb-embed-done:focus-visible{outline:2px solid #6aa6ff;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.cb-embed,.cb-embed iframe{transition:none}.cb-embed-spin::after{animation-duration:3s}}
`;

const DONE_MARGIN = 10;
// Flying in on a card to interact with it: the screen padding around it, and a hair over the zoom a frame
// mounts at, so the rounding of the fly cannot land under it.
const FLY_PAD = 48;
const FLY_IN_SCALE = MIN_LIVE_SCALE * 1.05;
// Leave the iframe's pixels alone this long after a poster swap before revoking the old blob.
const REVOKE_DELAY_MS = 15000;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// A box and a rect that touch count as overlapping.
const overlaps = (b: { minX: number; minY: number; maxX: number; maxY: number }, v: Rect): boolean =>
  b.maxX >= v.x0 && b.minX <= v.x1 && b.maxY >= v.y0 && b.minY <= v.y1;

const normMinLive = (m: EmbedOptions['minLivePx']): { w: number; h: number } =>
  m === undefined
    ? { w: 0, h: 0 }
    : typeof m === 'number'
      ? { w: m, h: (m * MIN_LIVE_H) / MIN_LIVE_W }
      : m;

export class EmbedLayer {
  private readonly root: HTMLElement;
  private readonly host: HTMLElement;
  private readonly store: Store;
  private readonly stage: Stage;
  private readonly emit: EmbedLayerDeps['emit'];
  private readonly doc: Document;
  private readonly entries = new Map<ElementId, Entry>();
  private readonly frames = new Map<ElementId, Frame>();
  private readonly done: HTMLButtonElement;
  private readonly cleanups: (() => void)[] = [];
  // Pending revokes of retired poster blobs: timer -> URL (dispose revokes the rest at once).
  private readonly timers = new Map<ReturnType<typeof setTimeout>, string>();
  private readonly appOrigin: string | undefined;
  private opts: Required<Pick<EmbedOptions, 'maxLive' | 'maxLiveTouch' | 'maxMounted' | 'maxMountedTouch' | 'maxOffscreen' | 'maxOffscreenTouch' | 'resolveTimeoutMs' | 'cullMargin'>> & {
    minLive: { w: number; h: number };
    minLiveScale: number;
    resolve?: EmbedResolver;
    resolution: EmbedResolution;
    arbitrarySameOrigin: boolean;
    autoplay: boolean;
    maxLoading: number;
    freezePx: number;
    maxAnimating: number;
    adaptive: boolean;
  };
  private selected = new Set<ElementId>();
  private touch = false;
  private moving = false;
  private planDirty = false;
  private interactId: ElementId | null = null;
  // Double-click on a card too small to mount (zoomed far out): fly to it, then interact.
  private pendingInteract: ElementId | null = null;
  private clock = 0;
  private snapSeq = 0;
  private revealSeq = 0;
  // Snapshot requests in flight.
  private snapping = 0;
  private disposed = false;
  private readonly raf: ((cb: (time: number) => void) => number) | undefined;
  private readonly caf: ((id: number) => void) | undefined;
  private readonly rasterize: (svg: string, w: number, h: number) => Promise<Blob | null>;
  // The adaptive limit on animating frames (Infinity: none); the effective budget also honours maxAnimating.
  private adaptiveN = Infinity;
  private animatingIds = new Set<ElementId>();
  // Frames that were candidates for a slot at the last ranking, and whether anything visible renders.
  private candidates = 0;
  private rendering = false;
  // A frame froze or thawed since the last ranking.
  private rankDirty = false;
  private sampler: Sampler | null = null;
  private smooth = 0;
  // The fastest the display has shown it can go (fps; 0: not known yet).
  private peakFps = 0;

  constructor(deps: EmbedLayerDeps, options: EmbedOptions = {}) {
    this.host = deps.host;
    this.store = deps.store;
    this.stage = deps.stage;
    this.emit = deps.emit;
    this.doc = deps.root.ownerDocument;
    const win = this.doc.defaultView;
    this.raf = deps.raf ?? (win ? (cb) => win.requestAnimationFrame(cb) : undefined);
    this.caf = deps.caf ?? (win ? (id) => win.cancelAnimationFrame(id) : undefined);
    this.rasterize = deps.rasterize ?? ((svg, w, h) => rasterizeSvg(this.doc, svg, w, h));
    this.appOrigin = typeof location !== 'undefined' ? location.origin : undefined;
    this.opts = {
      maxLive: options.maxLive ?? MAX_LIVE_DESKTOP,
      maxLiveTouch: options.maxLiveTouch ?? MAX_LIVE_TOUCH,
      maxMounted: options.maxMounted ?? MAX_MOUNTED_DESKTOP,
      maxMountedTouch: options.maxMountedTouch ?? MAX_MOUNTED_TOUCH,
      maxOffscreen: options.maxOffscreen ?? MAX_OFFSCREEN_DESKTOP,
      maxOffscreenTouch: options.maxOffscreenTouch ?? MAX_OFFSCREEN_TOUCH,
      cullMargin: options.cullMargin ?? CULL_MARGIN,
      resolveTimeoutMs: options.resolveTimeoutMs ?? 4000,
      minLive: normMinLive(options.minLivePx),
      minLiveScale: options.minLiveScale ?? 0,
      resolve: options.resolve,
      resolution: options.resolution ?? DEFAULT_RESOLUTION,
      arbitrarySameOrigin: options.arbitrarySameOrigin ?? true,
      autoplay: options.autoplay ?? false,
      maxLoading: options.maxLoading ?? MAX_LOADING,
      freezePx: options.freezePx ?? FREEZE_PX,
      maxAnimating: normBudget(options.maxAnimating ?? Infinity),
      adaptive: options.adaptive ?? true,
    };

    if (!this.doc.getElementById(STYLE_ID)) {
      const style = this.doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      this.doc.head.appendChild(style);
    }
    this.root = this.doc.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    deps.root.appendChild(this.root);

    this.done = this.doc.createElement('button');
    this.done.type = 'button';
    this.done.className = 'cb-embed-done';
    this.done.textContent = 'Done';
    this.done.setAttribute('aria-label', 'Done interacting with the embed');
    // The board listens on its host: nothing the button gets may reach it.
    for (const t of ['pointerdown', 'pointerup', 'dblclick', 'wheel', 'keydown'] as const) {
      this.done.addEventListener(t, (e) => {
        if (t === 'keydown' && (e as KeyboardEvent).key === 'Escape') return;
        e.stopPropagation();
      });
    }
    this.done.addEventListener('click', () => this.exitInteract());
    this.root.appendChild(this.done);

    const onDown = (e: PointerEvent): void => {
      if (this.interactId === null) return;
      const f = this.frames.get(this.interactId);
      const t = e.target as Node | null;
      if (f && t && (f.wrapper.contains(t) || this.done.contains(t))) return;
      this.exitInteract();
    };
    const onKeyDoc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && this.interactId !== null) {
        e.stopPropagation();
        this.exitInteract();
      }
    };
    const onKeyHost = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.target !== this.host || e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.interactId !== null || this.selected.size !== 1) return;
      const id = [...this.selected][0];
      if (this.entries.has(id) && this.activate(id, true)) e.preventDefault();
    };
    this.doc.addEventListener('pointerdown', onDown, true);
    this.doc.addEventListener('keydown', onKeyDoc, true);
    this.host.addEventListener('keydown', onKeyHost);
    this.cleanups.push(
      () => this.doc.removeEventListener('pointerdown', onDown, true),
      () => this.doc.removeEventListener('keydown', onKeyDoc, true),
      () => this.host.removeEventListener('keydown', onKeyHost),
      this.store.subscribe((e) => this.onStore(e)),
    );
    const onVisibility = (): void => this.syncSampler();
    this.doc.addEventListener('visibilitychange', onVisibility);
    this.cleanups.push(() => this.doc.removeEventListener('visibilitychange', onVisibility));
    if (win) {
      const onMessage = (e: MessageEvent): void => this.onMessage(e);
      win.addEventListener('message', onMessage);
      this.cleanups.push(() => win.removeEventListener('message', onMessage));
    }
    for (const el of this.store.elements()) this.track(el);
  }

  // ── Public ─────────────────────────────────────────────────────────────────
  // Ids of the cards that hold a mounted iframe now (active and parked).
  get live(): ReadonlySet<ElementId> {
    return new Set(this.frames.keys());
  }

  // ... of which these are parked: mounted but inert, showing their last frame.
  get parked(): ReadonlySet<ElementId> {
    const out = new Set<ElementId>();
    for (const [id, f] of this.frames) if (f.wrapper.dataset.parked !== undefined) out.add(id);
    return out;
  }

  // ... and of those, these are off screen: hidden (`data-culled`), not rendering, still alive.
  get culled(): ReadonlySet<ElementId> {
    const out = new Set<ElementId>();
    for (const [id, f] of this.frames) if (f.culled) out.add(id);
    return out;
  }

  // ... and these are frozen: a snapshot is their poster and the frame is hidden (`data-frozen`), alive.
  get frozen(): ReadonlySet<ElementId> {
    const out = new Set<ElementId>();
    for (const [id, f] of this.frames) if (f.frozen) out.add(id);
    return out;
  }

  // ... and of those, these animate: they can be paused and are within the animating budget. A page that
  // cannot be paused is never in it (it takes no slot), nor is a parked, culled or frozen frame.
  get animating(): ReadonlySet<ElementId> {
    const out = new Set<ElementId>();
    for (const id of this.animatingIds) if (this.frames.has(id)) out.add(id);
    return out;
  }

  // How many frames may animate now: maxAnimating, lowered by the adaptive sampler (Infinity: no limit).
  get animatingBudget(): number {
    return Math.min(this.opts.maxAnimating, this.adaptiveN);
  }

  // Ids of the cards whose iframe is mounted and still loading (the spinner shows).
  get loading(): ReadonlySet<ElementId> {
    const out = new Set<ElementId>();
    for (const [id, f] of this.frames) if (!f.loaded) out.add(id);
    return out;
  }

  // The card in interact mode (null: none).
  get interacting(): ElementId | null {
    return this.interactId;
  }

  get maxLive(): number {
    return this.touch ? this.opts.maxLiveTouch : this.opts.maxLive;
  }

  get maxMounted(): number {
    return this.touch ? this.opts.maxMountedTouch : this.opts.maxMounted;
  }

  get maxOffscreen(): number {
    return this.touch ? this.opts.maxOffscreenTouch : this.opts.maxOffscreen;
  }

  // What is known about a card's embed (null: not an embed card).
  info(id: ElementId): Readonly<ResolvedEmbed> | null {
    return this.entries.get(id)?.info ?? null;
  }

  get resolution(): EmbedResolution {
    return this.opts.resolution;
  }

  setOptions(o: EmbedOptions): void {
    if (o.maxLive !== undefined) this.opts.maxLive = o.maxLive;
    if (o.maxLoading !== undefined) this.opts.maxLoading = o.maxLoading;
    if (o.freezePx !== undefined) this.opts.freezePx = Math.max(0, o.freezePx);
    if (o.maxAnimating !== undefined) this.opts.maxAnimating = normBudget(o.maxAnimating);
    if (o.adaptive !== undefined && o.adaptive !== this.opts.adaptive) {
      this.opts.adaptive = o.adaptive;
      // Off: back to the ceiling.
      if (!o.adaptive) this.adaptiveN = Infinity;
      this.smooth = 0;
    }
    if (o.maxLiveTouch !== undefined) this.opts.maxLiveTouch = o.maxLiveTouch;
    if (o.maxMounted !== undefined) this.opts.maxMounted = o.maxMounted;
    if (o.maxMountedTouch !== undefined) this.opts.maxMountedTouch = o.maxMountedTouch;
    if (o.maxOffscreen !== undefined) this.opts.maxOffscreen = o.maxOffscreen;
    if (o.cullMargin !== undefined) this.opts.cullMargin = o.cullMargin;
    if (o.maxOffscreenTouch !== undefined) this.opts.maxOffscreenTouch = o.maxOffscreenTouch;
    if (o.minLivePx !== undefined) this.opts.minLive = normMinLive(o.minLivePx);
    if (o.minLiveScale !== undefined) this.opts.minLiveScale = o.minLiveScale;
    if (o.resolution !== undefined) {
      this.opts.resolution = o.resolution;
      for (const [id, f] of this.frames) this.place(id, f);
    }
    const sandboxChanged = o.arbitrarySameOrigin !== undefined && o.arbitrarySameOrigin !== this.opts.arbitrarySameOrigin;
    const autoplayChanged = o.autoplay !== undefined && o.autoplay !== this.opts.autoplay;
    if (sandboxChanged || autoplayChanged) {
      if (o.arbitrarySameOrigin !== undefined) this.opts.arbitrarySameOrigin = o.arbitrarySameOrigin;
      if (o.autoplay !== undefined) this.opts.autoplay = o.autoplay;
      for (const [id, e] of this.entries) {
        if (!e.ready) continue;
        const before = e.spec;
        e.spec = this.specFor(e);
        // A live frame is rebuilt with the new sandbox or URL the next time it mounts.
        if ((e.spec?.sandbox !== before?.sandbox || e.spec?.src !== before?.src) && this.frames.has(id)) {
          this.destroyFrame(id);
        }
      }
    }
    this.rerank();
    this.requestPlan();
  }

  // Interact mode on a card: make it live (whatever its size) and give it pointer events. A card the page
  // refuses to frame opens its URL in a new tab instead. Returns false when there is nothing to do.
  interact(id: ElementId): boolean {
    return this.activate(id, false);
  }

  exitInteract(): void {
    const id = this.interactId;
    this.pendingInteract = null;
    if (id === null) return;
    this.interactId = null;
    const f = this.frames.get(id);
    if (f) {
      delete f.wrapper.dataset.interact;
    }
    this.done.style.display = 'none';
    this.rerank();
    // Keys belong to the board again.
    if (this.doc.activeElement && this.doc.activeElement !== this.host) {
      try {
        this.host.focus({ preventScroll: true });
      } catch {
        // Not focusable.
      }
    }
    this.emit('embedInteract', { id, active: false });
    this.requestPlan();
  }

  // ── Board hooks ────────────────────────────────────────────────────────────
  setSelection(ids: readonly ElementId[]): void {
    this.selected = new Set(ids);
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) e.lastUsed = ++this.clock;
    }
    if (this.interactId !== null && !this.selected.has(this.interactId)) this.exitInteract();
    // The card was deselected while the camera flew in: that interact is stale.
    if (this.pendingInteract !== null && !this.selected.has(this.pendingInteract)) this.pendingInteract = null;
    this.rerank();
    this.requestPlan();
  }

  setTouch(touch: boolean): void {
    if (touch === this.touch) return;
    this.touch = touch;
    this.requestPlan();
  }

  onDblClick(id: ElementId | null): void {
    if (id !== null && this.entries.has(id)) this.activate(id, false);
  }

  // Generated tiles follow the theme.
  setTheme(): void {
    for (const [id, e] of this.entries) if (e.ownKind === 'tile') void this.makeTile(id, e, e.token);
  }

  onFrame(camChanged: boolean): void {
    if (this.disposed) return;
    if (camChanged) this.moving = true;
    // One stamp per frame: whatever is in view now was seen at this tick, so the order of leaving is known.
    const view = this.cullRect();
    const seen = ++this.clock;
    for (const [id, f] of this.frames) this.place(id, f, view, seen);
    if (!this.moving && this.planDirty) this.runPlan();
    // Only a frame that froze or thawed asks for it here; everything else ranks on settle.
    else if (this.rankDirty) this.rerank();
  }

  onSettle(): void {
    if (this.disposed) return;
    this.moving = false;
    this.planDirty = true;
    if (this.pendingInteract !== null) {
      const id = this.pendingInteract;
      this.pendingInteract = null;
      // One try: a camera that could not fly in far enough does not fly again.
      if (this.activate(id, false, true)) return;
    }
    this.runPlan();
  }

  dispose(): void {
    if (this.disposed) return;
    this.exitInteract();
    this.disposed = true;
    this.stopSampler();
    for (const id of [...this.frames.keys()]) this.destroyFrame(id);
    for (const e of this.entries.values()) {
      if (e.ownUrl) URL.revokeObjectURL(e.ownUrl);
      for (const u of e.stale) URL.revokeObjectURL(u);
    }
    for (const [t, url] of this.timers) {
      clearTimeout(t);
      URL.revokeObjectURL(url);
    }
    this.timers.clear();
    this.entries.clear();
    for (const f of this.cleanups) f();
    this.root.remove();
  }

  // ── Tracking and resolution ────────────────────────────────────────────────
  private onStore(e: StoreEvent): void {
    if (e.type !== 'change' || this.disposed) return;
    for (const el of e.change.removed) this.untrack(el.id);
    // What the store holds now: a card added or updated and then removed in the same batch is gone.
    for (const el of e.change.added) this.trackCurrent(el.id);
    for (const u of e.change.updated) this.trackCurrent(u.el.id);
    this.planDirty = true;
  }

  private untrack(id: ElementId): void {
    if (this.frames.has(id)) this.destroyFrame(id);
    if (this.interactId === id) this.exitInteract();
    const e = this.entries.get(id);
    if (!e) return;
    e.token++;
    if (e.ownUrl) this.retire(e.ownUrl);
    for (const u of e.stale) this.retire(u);
    this.entries.delete(id);
  }

  private trackCurrent(id: ElementId): void {
    const el = this.store.get(id);
    if (el) this.track(el);
  }

  private track(el: Element): void {
    const embed = el.media.embed;
    if (el.kind !== 'embed' || !embed) {
      this.untrack(el.id);
      return;
    }
    const prev = this.entries.get(el.id);
    if (prev && sameEmbed(prev.embed, embed)) {
      // Fields `sameEmbed` ignores (the per-card `resolution`, the title) are not new content: the frame, its
      // page and interact mode stay, only what shows them changes.
      if (prev.embed !== embed) {
        const retitled = prev.embed.title !== embed.title;
        prev.embed = embed;
        if (retitled) this.retitle(el.id, prev);
        const f = this.frames.get(el.id);
        if (f) this.place(el.id, f);
        this.requestPlan();
      }
      // The host replaced `media` wholesale and dropped the poster this layer had written: put it back.
      if (el.media.src === undefined && prev.ownUrl) this.writePoster(el.id, prev.ownUrl);
      return;
    }
    const stale = new Set<string>();
    if (prev) {
      if (this.frames.has(el.id)) this.destroyFrame(el.id);
      if (this.interactId === el.id) this.exitInteract();
      prev.token++;
      if (prev.ownUrl) stale.add(prev.ownUrl);
      for (const u of prev.stale) stale.add(u);
    }
    const info = baseResolved(embed);
    const entry: Entry = {
      embed,
      info,
      ready: false,
      spec: null,
      token: (prev?.token ?? 0) + 1,
      ownUrl: null,
      ownKind: null,
      stale,
      initialAspect: el.w > 0 ? el.h / el.w : 1,
      lastUsed: prev?.lastUsed ?? 0,
      lastSeen: prev?.lastSeen ?? 0,
    };
    this.entries.set(el.id, entry);
    // No resolver: what the URL says is final, and the card can go live at once.
    if (!this.opts.resolve || info.kind === 'html' || info.url === '') this.settle(entry);
    void this.resolve(el.id, entry);
  }

  // The card's own title wins over the resolver's. Redraws a generated tile with the new one.
  private retitle(id: ElementId, entry: Entry): void {
    entry.info = { ...entry.info, title: entry.embed.title ?? entry.resolverTitle };
    if (entry.ready) {
      entry.spec = this.specFor(entry);
      const f = this.frames.get(id);
      if (f && entry.spec) f.iframe.title = entry.spec.title;
    }
    if (entry.ownKind === 'tile') void this.makeTile(id, entry, entry.token);
  }

  private settle(entry: Entry): void {
    entry.ready = true;
    entry.spec = this.specFor(entry);
    if (entry.spec === null && entry.info.kind === 'url') entry.info = { ...entry.info, frameable: false };
    this.requestPlan();
  }

  private specFor(entry: Entry): IframeSpec | null {
    if (!canGoLive(entry.info)) return null;
    const spec = iframeSpecFor({
      source: entry.embed,
      iframeSrc: entry.info.iframeSrc ?? undefined,
      appOrigin: this.appOrigin,
      arbitrarySameOrigin: this.opts.arbitrarySameOrigin,
    });
    // Only the URL the iframe loads changes; `entry.info` keeps the plain one.
    if (spec?.src !== undefined) {
      spec.src = withJsApi(spec.provider, spec.src, this.appOrigin);
      if (this.opts.autoplay) spec.src = withAutoplay(spec.provider, spec.src);
    }
    return spec;
  }

  private async resolve(id: ElementId, entry: Entry): Promise<void> {
    // Never inside the store's change notification that got us here.
    await Promise.resolve();
    const token = entry.token;
    const alive = (): boolean => !this.disposed && this.entries.get(id) === entry && entry.token === token;
    if (!entry.ready) {
      let answer: Awaited<ReturnType<EmbedResolver>> = null;
      const resolver = this.opts.resolve;
      if (resolver) {
        try {
          answer = await withTimeout(Promise.resolve(resolver(entry.info.url)), this.opts.resolveTimeoutMs);
        } catch (err) {
          console.warn('[corkboard] embed resolver failed:', err);
        }
      }
      if (!alive()) return;
      if (typeof answer?.title === 'string' && answer.title !== '') entry.resolverTitle = answer.title;
      entry.info = mergeResolved(entry.info, answer);
      this.settle(entry);
    }
    // The shape a resolver reported, for a card that still has the shape it was created with.
    const el = this.store.get(id);
    if (!el || !alive()) return;
    const a = entry.info.aspect;
    const cur = el.w > 0 ? el.h / el.w : 1;
    if (
      a !== undefined &&
      el.media.aspect === undefined &&
      Math.abs(cur - entry.initialAspect) < 0.01 &&
      Math.abs(a - cur) > 0.005
    ) {
      this.store.update(id, { h: Math.max(1, Math.round(el.w * a)) });
    }
    // A picture of the host's stays as it is; otherwise this layer supplies one.
    const hostPoster = this.needsPoster(id) ? undefined : this.store.get(id)?.media.src;
    const photo = hostPoster === undefined ? await this.loadPoster(id, entry, token) : null;
    if (!alive()) return;
    this.emit('embedResolved', {
      id,
      provider: entry.info.provider,
      frameable: entry.info.frameable,
      aspect: entry.info.aspect,
      title: entry.info.title,
      // A URL worth persisting: the host's, or a provider thumbnail. A generated tile is a blob that dies
      // with the page, so it is not reported.
      poster: hostPoster ?? photo ?? undefined,
    });
  }

  // The card has no picture of the host's: this layer supplies one. Any `blob:` src counts as ours: the ones
  // this entry made (current or stale), and those of an earlier session that a saved `board.all()` or an
  // undo stack brought back, whose blob died with that page. (So a host's own `blob:` poster on an embed
  // card is replaced: give it an https or data: URL.)
  private needsPoster(id: ElementId): boolean {
    const src = this.store.get(id)?.media.src;
    return src === undefined || src.startsWith('blob:');
  }

  // Returns the candidate URL that became the poster, null for a generated tile.
  private async loadPoster(id: ElementId, entry: Entry, token: number): Promise<string | null> {
    const alive = (): boolean => !this.disposed && this.entries.get(id) === entry && entry.token === token;
    for (const candidate of entry.info.posters) {
      const url = await fetchPoster(candidate);
      if (!alive()) {
        if (url) URL.revokeObjectURL(url);
        return null;
      }
      if (url) {
        this.applyPoster(id, entry, url, 'photo');
        return candidate;
      }
    }
    await this.makeTile(id, entry, token);
    return null;
  }

  private async makeTile(id: ElementId, entry: Entry, token: number): Promise<void> {
    const el = this.store.get(id);
    if (!el) return;
    const theme: Theme = this.stage.activeTheme;
    const blob = await drawTile(tileSpec(entry.info), el.w > 0 ? el.h / el.w : 0.5625, theme);
    if (!blob) return;
    if (this.disposed || this.entries.get(id) !== entry || entry.token !== token) return;
    this.applyPoster(id, entry, URL.createObjectURL(blob), 'tile');
  }

  private applyPoster(id: ElementId, entry: Entry, url: string, kind: 'photo' | 'tile' | 'snapshot'): void {
    // A late tile or photo never covers the last frame of a card that went live.
    if (kind !== 'snapshot' && entry.ownKind === 'snapshot') {
      URL.revokeObjectURL(url);
      return;
    }
    const prev = entry.ownUrl;
    entry.ownUrl = url;
    entry.ownKind = kind;
    this.writePoster(id, url);
    if (prev) this.retire(prev);
    for (const u of entry.stale) this.retire(u);
    entry.stale.clear();
  }

  private writePoster(id: ElementId, url: string): void {
    const el = this.store.get(id);
    if (el) this.store.update(id, { media: { ...el.media, src: url } });
    else URL.revokeObjectURL(url);
  }

  // The old texture may still be in flight in a decode worker: revoke later.
  private retire(url: string): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      URL.revokeObjectURL(url);
    }, REVOKE_DELAY_MS);
    this.timers.set(t, url);
  }

  // ── Live iframes ───────────────────────────────────────────────────────────
  private requestPlan(): void {
    this.planDirty = true;
    this.stage.markDirty();
  }

  // The visible rect grown by `cullMargin` of the viewport on each side: what counts as on screen.
  private cullRect(): Rect {
    const v = this.stage.cam.visibleRect();
    const mx = (v.x1 - v.x0) * this.opts.cullMargin;
    const my = (v.y1 - v.y0) * this.opts.cullMargin;
    return { x0: v.x0 - mx, y0: v.y0 - my, x1: v.x1 + mx, y1: v.y1 + my };
  }

  private cards(): PolicyCard[] {
    const cam = this.stage.cam;
    const view = cam.visibleRect();
    const grown = this.cullRect();
    const seen = ++this.clock;
    const k = cam.scale;
    const out: PolicyCard[] = [];
    for (const [id, entry] of this.entries) {
      const el = this.store.get(id);
      if (!el || !entry.ready) continue;
      const r = this.stage.previewRectOf(id) ?? el;
      const b = elementBox({ x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot });
      // The part of the card that is in view: a neighbour with a sliver showing is not worth an iframe.
      const visW = (Math.min(b.maxX, view.x1) - Math.max(b.minX, view.x0)) * k;
      const visH = (Math.min(b.maxY, view.y1) - Math.max(b.minY, view.y0)) * k;
      const onScreen = overlaps(b, grown);
      if (onScreen) entry.lastSeen = seen;
      out.push({
        id,
        screenW: Math.min(r.w * k, visW),
        screenH: Math.min(r.h * k, visH),
        onScreen,
        selected: this.selected.has(id),
        interacting: this.interactId === id,
        frameable: entry.spec !== null,
        live: this.frames.has(id),
        lastUsed: entry.lastUsed,
        lastSeen: entry.lastSeen,
      });
    }
    return out;
  }

  private runPlan(force = false): void {
    this.planDirty = false;
    const plan = planLive({
      cards: this.cards(),
      cameraMoving: this.moving && !force,
      scale: this.stage.cam.scale,
      max: this.maxLive,
      maxMounted: this.maxMounted,
      maxOffscreen: this.maxOffscreen,
      minW: this.opts.minLive.w,
      minH: this.opts.minLive.h,
      minScale: this.opts.minLiveScale,
    });
    for (const id of plan.destroy) this.destroyFrame(id);
    // Chunked start: only as many new frames as there are free loading slots. The rest wait for the next
    // plan, which a load (or a slot timing out) asks for. The card in interact mode never waits.
    let free = this.opts.maxLoading;
    for (const f of this.frames.values()) if (f.slot) free--;
    for (const id of this.byPriority(plan.mount)) {
      if (free <= 0 && id !== this.interactId) continue;
      this.mountFrame(id);
      free--;
    }
    // Parked frames stay on screen but are never in interact mode (an interacting card is always active).
    // `plan.culled` needs no work here: `place()` hides the off-screen frames every frame.
    const parked = new Set(plan.parked);
    const settled = !this.moving;
    for (const [id, f] of this.frames) {
      if (parked.has(id)) {
        if (this.interactId === id) this.exitInteract();
        f.wrapper.dataset.parked = '';
        f.parked = true;
      } else {
        delete f.wrapper.dataset.parked;
        f.parked = false;
      }
    }
    // After parking is known and before each frame is tuned, so the pause it gets already counts the budget.
    this.rerank();
    for (const [id, f] of this.frames) {
      this.tune(id, f, this.stage.previewRectOf(id) ?? this.store.get(id), settled);
    }
  }

  // Interacting, then selected, then nearest the centre of the view.
  private byPriority(ids: readonly ElementId[]): ElementId[] {
    if (ids.length < 2) return [...ids];
    const v = this.stage.cam.visibleRect();
    const cx = (v.x0 + v.x1) / 2;
    const cy = (v.y0 + v.y1) / 2;
    const rank = new Map<ElementId, number>();
    for (const id of ids) {
      const r = this.stage.previewRectOf(id) ?? this.store.get(id);
      const d = r ? Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy) : Infinity;
      const tier = this.interactId === id ? 0 : this.selected.has(id) ? 1 : 2;
      rank.set(id, tier * 1e12 + d);
    }
    return [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  }

  private releaseSlot(f: Frame): void {
    if (f.slotTimer !== null) clearTimeout(f.slotTimer);
    f.slotTimer = null;
    if (!f.slot) return;
    f.slot = false;
    // The next chunk can start.
    this.requestPlan();
  }

  private mountFrame(id: ElementId): void {
    const entry = this.entries.get(id);
    const spec = entry?.spec;
    if (!entry || !spec || this.frames.has(id)) return;
    const wrapper = this.doc.createElement('div');
    wrapper.className = 'cb-embed';
    const iframe = this.doc.createElement('iframe');
    iframe.title = spec.title;
    iframe.setAttribute('sandbox', spec.sandbox);
    iframe.setAttribute('allow', spec.allow);
    iframe.setAttribute('referrerpolicy', spec.referrerPolicy);
    iframe.setAttribute('loading', spec.loading);
    if (spec.srcdoc !== undefined) iframe.srcdoc = spec.srcdoc;
    else if (spec.src !== undefined) iframe.src = spec.src;
    const frame: Frame = {
      wrapper,
      iframe,
      loaded: false,
      slot: true,
      slotTimer: null,
      w: NaN,
      h: NaN,
      transform: '',
      z: NaN,
      culled: false,
      cullTimer: null,
      cullSnapAt: -Infinity,
      reveal: null,
      parked: false,
      kind: spec.profile === 'snippet' ? 'snippet' : spec.provider === 'youtube' || spec.provider === 'vimeo' ? 'video' : 'page',
      provider: spec.provider,
      origin: originOf(spec.src),
      small: false,
      frozen: false,
      snapFailed: false,
      snapTries: 0,
      retry: null,
      snap: null,
      landTimer: null,
      paused: false,
      interacted: false,
      loadTimer: null,
      overBudget: false,
    };
    frame.slotTimer = setTimeout(() => this.releaseSlot(frame), LOAD_SLOT_MS);
    iframe.addEventListener('load', () => {
      frame.loaded = true;
      wrapper.dataset.ready = '';
      // The wrapper turns white with `ready`: not before the page has painted.
      this.reveal(frame);
      this.releaseSlot(frame);
      // Pause, resume and snapshots only talk to a loaded document; the plan decides about a snapshot.
      this.syncPause(id, frame, false);
      if (frame.kind === 'video') {
        frame.loadTimer = setTimeout(() => {
          frame.loadTimer = null;
          this.syncPause(id, frame, true);
        }, PLAYER_READY_MS);
      }
      this.requestPlan();
    });
    // Until the page has loaded: the poster under a veil, and a spinner sized to the card.
    const spin = this.doc.createElement('div');
    spin.className = 'cb-embed-spin';
    spin.setAttribute('role', 'progressbar');
    spin.setAttribute('aria-label', 'Loading embed');
    wrapper.append(spin, iframe);
    const el = this.store.get(id);
    if (el) wrapper.style.borderRadius = `${el.radius}px`;
    this.frames.set(id, frame);
    entry.lastUsed = ++this.clock;
    this.place(id, frame);
    this.root.insertBefore(wrapper, this.done);
    this.emit('embedLive', { id, live: true });
  }

  private destroyFrame(id: ElementId): void {
    const f = this.frames.get(id);
    if (!f) return;
    this.frames.delete(id);
    this.animatingIds.delete(id);
    if (f.slotTimer !== null) clearTimeout(f.slotTimer);
    if (f.loadTimer !== null) clearTimeout(f.loadTimer);
    if (f.retry !== null) clearTimeout(f.retry);
    if (f.cullTimer !== null) clearTimeout(f.cullTimer);
    f.cullTimer = null;
    this.endReveal(f);
    this.cancelSnapshot(f);
    if (this.interactId === id) this.exitInteract();
    // Navigate away first so the page (and its process) is released, then drop the node.
    f.iframe.removeAttribute('srcdoc');
    f.iframe.src = 'about:blank';
    f.wrapper.remove();
    this.emit('embedLive', { id, live: false });
  }

  // Writes size and transform only when they changed.
  // `view`: the cull rect (computed once per frame by the caller); `seen`: stamp for cards in view.
  private place(id: ElementId, f: Frame, view: Rect = this.cullRect(), seen = 0): void {
    const r = this.stage.previewRectOf(id) ?? this.store.get(id);
    if (!r) return;
    // The card in interact mode is never hidden. A rotated card is tested by its bounding box.
    const off = this.interactId !== id && !overlaps(elementBox({ x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot }), view);
    if (off !== f.culled) {
      f.culled = off;
      if (off) this.cull(id, f);
      else this.uncull(f);
    }
    if (!off && seen > 0) {
      const entry = this.entries.get(id);
      if (entry) entry.lastSeen = seen;
    }
    const cam: Camera = this.stage.cam.cam;
    const res = this.entries.get(id)?.embed.resolution ?? this.opts.resolution;
    const p = embedPlacement({ x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot }, cam, res);
    const s = f.wrapper.style;
    if (p.width !== f.w) {
      f.w = p.width;
      s.width = `${p.width}px`;
    }
    if (p.height !== f.h) {
      f.h = p.height;
      s.height = `${p.height}px`;
    }
    if (p.transform !== f.transform) {
      f.transform = p.transform;
      s.transform = p.transform;
    }
    const z = this.store.rank(id) + 1;
    if (z !== f.z) {
      f.z = z;
      s.zIndex = String(z);
    }
    if (this.interactId === id) {
      const w = this.stage.cam.width;
      const h = this.stage.cam.height;
      const x = Math.min(Math.max(p.topRightX, 90), w) - DONE_MARGIN;
      const y = Math.min(Math.max(p.topRightY, 0), h - 40) + DONE_MARGIN;
      this.done.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translateX(-100%)`;
    }
    // Not yet settled: a frame can come back (grow, get selected) or be paused (culled) at once, but only the
    // plan, once the camera is still, sends one to sleep.
    this.tune(id, f, r, false);
  }

  // ── Leaving and returning ──────────────────────────────────────────────────
  // The card left the view. A loaded snippet is snapshotted first and hidden when that is done (its last frame
  // then waits as the poster); anything else is hidden at once.
  private cull(id: ElementId, f: Frame): void {
    this.endReveal(f);
    if (!this.canSnapCull(id, f) || !this.requestSnapshot(id, f, true)) {
      f.wrapper.dataset.culled = '';
      return;
    }
    f.wrapper.dataset.culling = '';
    f.cullTimer = setTimeout(() => this.finishCull(f), CULL_SNAPSHOT_MS);
    f.cullSnapAt = Date.now();
  }

  private canSnapCull(id: ElementId, f: Frame): boolean {
    return (
      f.kind === 'snippet' &&
      f.loaded &&
      !f.frozen &&
      !f.snap &&
      f.landTimer === null &&
      this.snapping < MAX_SNAPSHOTS - CULL_SNAPSHOT_RESERVE &&
      Date.now() - f.cullSnapAt >= CULL_SNAPSHOT_MIN_MS &&
      this.entries.has(id)
    );
  }

  // The snapshot is in (or took too long): hide the frame, if its card is still away.
  private finishCull(f: Frame): void {
    if (f.cullTimer !== null) clearTimeout(f.cullTimer);
    f.cullTimer = null;
    delete f.wrapper.dataset.culling;
    if (f.culled) f.wrapper.dataset.culled = '';
  }

  // The card is back. A frame still waiting to be hidden never was: nothing to reveal.
  private uncull(f: Frame): void {
    if (f.snap?.cull) {
      this.cancelSnapshot(f);
      // Nothing came of it: the next time the card leaves may ask again.
      f.cullSnapAt = -Infinity;
    }
    if (f.cullTimer !== null) {
      this.finishCull(f);
      return;
    }
    if (f.wrapper.dataset.culled === undefined) return;
    delete f.wrapper.dataset.culled;
    this.reveal(f);
  }

  // Every path from hidden (or not loaded yet) to visible goes through here: the first load, a card coming
  // back into the cull rect, a frozen frame thawing. A frame that was not on screen has painted nothing yet, and
  // the wrapper behind it is white: transparent until it has painted, so the poster under it shows instead.
  // A frame that never loaded keeps its veil; one that is still hidden for another reason reveals when that ends.
  private reveal(f: Frame): void {
    if (!f.loaded || f.frozen || f.wrapper.dataset.culled !== undefined) return;
    this.endReveal(f);
    const snippet = f.kind === 'snippet';
    const id = ++this.revealSeq;
    // A snippet reports when it painted (REVEAL_MAX_MS if it cannot); a page that cannot is given a moment.
    f.reveal = { id, timer: setTimeout(() => this.endReveal(f), snippet ? REVEAL_MAX_MS : REVEAL_MS) };
    f.wrapper.dataset.revealing = '';
    if (snippet) this.post(f, { cb: EMBED_CB, op: 'show', id }, '*');
  }

  private endReveal(f: Frame): void {
    if (!f.reveal) return;
    clearTimeout(f.reveal.timer);
    f.reveal = null;
    delete f.wrapper.dataset.revealing;
  }

  // ── Freeze and pause ───────────────────────────────────────────────────────
  // Decides what a mounted frame does with its card's size, selection and parking. Cheap enough to run on
  // every frame for every frame: it writes and posts only when something changed.
  private tune(id: ElementId, f: Frame, r: { w: number; h: number } | undefined, settled: boolean): void {
    const held = this.interactId === id || this.selected.has(id);
    if (this.interactId === id) f.interacted = true;
    const px = this.opts.freezePx;
    let small = f.small;
    if (px <= 0 || held) small = false;
    else if (r && !f.culled) {
      const short = Math.min(r.w, r.h) * this.stage.cam.scale;
      if (small) small = short < px * FREEZE_HYSTERESIS;
      else if (settled) small = short < px;
    }
    if (small !== f.small) {
      f.small = small;
      if (!small) {
        f.snapFailed = false;
        f.snapTries = 0;
        if (f.retry !== null) clearTimeout(f.retry);
        f.retry = null;
        this.cancelSnapshot(f);
        if (f.frozen) this.setFrozen(f, false);
      }
    }
    if (
      small &&
      settled &&
      f.kind === 'snippet' &&
      f.loaded &&
      !f.culled &&
      !f.frozen &&
      !f.snap &&
      f.landTimer === null &&
      !f.snapFailed &&
      this.snapping < MAX_SNAPSHOTS
    ) {
      this.requestSnapshot(id, f);
    }
    this.syncPause(id, f, false);
  }

  private setFrozen(f: Frame, frozen: boolean): void {
    f.frozen = frozen;
    // A frozen frame leaves the ranking and a thawed one joins it.
    this.rankDirty = true;
    if (frozen) {
      this.endReveal(f);
      f.wrapper.dataset.frozen = '';
    } else {
      delete f.wrapper.dataset.frozen;
      this.reveal(f);
    }
  }

  // Sends a snippet its pause / resume, or a video player its pause / play, when what it should be doing
  // changed. `force` repeats the pause to a player that may not have been listening yet.
  private syncPause(id: ElementId, f: Frame, force: boolean): void {
    if (!f.loaded) return;
    const interacting = this.interactId === id;
    if (f.kind === 'snippet') {
      const want = !interacting && (f.parked || f.culled || f.frozen || f.overBudget);
      if (want === f.paused) return;
      f.paused = want;
      this.post(f, { cb: EMBED_CB, op: want ? 'pause' : 'resume' }, '*');
    } else if (f.kind === 'video') {
      // A player nobody started does not play: pausing it would only for us to start it on the way back.
      const mayPlay = this.opts.autoplay || f.interacted;
      const want = mayPlay && !interacting && (f.small || f.parked || f.culled || f.overBudget);
      if (want === f.paused && !(force && want)) return;
      f.paused = want;
      this.command(f, want ? 'pause' : 'play');
    }
  }

  private post(f: Frame, msg: unknown, target: string): void {
    try {
      f.iframe.contentWindow?.postMessage(msg, target);
    } catch {
      // The frame is gone.
    }
  }

  // The player APIs: YouTube takes a JSON string, Vimeo an object, both only from the origin they were set up for.
  private command(f: Frame, op: 'pause' | 'play'): void {
    if (f.origin === '') return;
    if (f.provider === 'youtube') {
      const func = op === 'pause' ? 'pauseVideo' : 'playVideo';
      this.post(f, JSON.stringify({ event: 'command', func, args: [] }), f.origin);
    } else if (f.provider === 'vimeo') this.post(f, { method: op }, f.origin);
  }

  // ── Animating budget ───────────────────────────────────────────────────────
  // Whether a frame could be animating by itself: it can be paused, is not already asleep for another reason
  // (parked, culled, frozen, a small video) and, for a video, may be playing at all.
  private pausable(f: Frame): boolean {
    if (f.culled || f.frozen || f.parked) return false;
    if (f.kind === 'snippet') return true;
    return f.kind === 'video' && !f.small && (this.opts.autoplay || f.interacted);
  }

  // Ranks the frames that can be paused and pauses what is past the budget, resumes what is back inside it.
  // Interacting, then selected, then the most of the card in view, then nearest the centre. A page that cannot
  // be paused takes no slot (giving it one would change nothing) and is left alone.
  private rerank(): void {
    this.rankDirty = false;
    if (this.disposed) return;
    const cam = this.stage.cam;
    const v = cam.visibleRect();
    const k = cam.scale;
    const cx = (v.x0 + v.x1) / 2;
    const cy = (v.y0 + v.y1) / 2;
    const ranked: { id: ElementId; f: Frame; tier: number; area: number; dist: number }[] = [];
    let rendering = false;
    for (const [id, f] of this.frames) {
      if (!f.culled && !f.frozen) rendering = true;
      if (!this.pausable(f)) {
        this.setOverBudget(id, f, false);
        continue;
      }
      const r = this.stage.previewRectOf(id) ?? this.store.get(id);
      let area = 0;
      let dist = Infinity;
      if (r) {
        const b = elementBox({ x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot });
        area = Math.max(0, Math.min(b.maxX, v.x1) - Math.max(b.minX, v.x0)) * Math.max(0, Math.min(b.maxY, v.y1) - Math.max(b.minY, v.y0)) * k * k;
        dist = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
      }
      ranked.push({ id, f, tier: this.interactId === id ? 0 : this.selected.has(id) ? 1 : 2, area, dist });
    }
    ranked.sort((a, b) => a.tier - b.tier || b.area - a.area || a.dist - b.dist || (a.id < b.id ? -1 : 1));
    const budget = this.animatingBudget;
    const animating = new Set<ElementId>();
    ranked.forEach((c, i) => {
      const over = i >= budget;
      if (!over) animating.add(c.id);
      this.setOverBudget(c.id, c.f, over);
    });
    this.animatingIds = animating;
    this.candidates = ranked.length;
    this.rendering = rendering;
    this.syncSampler();
  }

  private setOverBudget(id: ElementId, f: Frame, over: boolean): void {
    if (over === f.overBudget) return;
    f.overBudget = over;
    this.syncPause(id, f, false);
  }

  // The sampler runs while there is something to slow down: adaptive on, a visible tab, and at least one
  // mounted frame that is on screen and not frozen.
  private syncSampler(): void {
    const want = this.opts.adaptive && !this.disposed && this.rendering && this.doc.visibilityState === 'visible';
    if (want && this.sampler === null) this.startSampler();
    else if (!want && this.sampler !== null) this.stopSampler();
  }

  private startSampler(): void {
    const raf = this.raf;
    if (!raf) return;
    const s: Sampler = { id: 0, start: NaN, last: NaN, frames: 0, discard: true, deltas: [] };
    this.sampler = s;
    this.smooth = 0;
    const tick = (ts: number): void => {
      if (this.sampler !== s) return;
      if (Number.isNaN(s.start) || ts - s.last > STALL_MS) {
        s.start = ts;
        s.frames = 0;
        s.deltas.length = 0;
        // The first window after a start sees frames mounting; one after a stall saw nothing.
        s.discard = true;
      } else {
        s.frames++;
        s.deltas.push(ts - s.last);
        if (ts - s.start >= SAMPLE_WINDOW_MS) {
          const fps = (s.frames * 1000) / (ts - s.start);
          const skip = s.discard;
          s.start = ts;
          s.frames = 0;
          s.discard = false;
          // Every window, discarded or not, tells how fast this display can go: rAF is aligned to vsync, so
          // even a loaded page has some frames one refresh apart. The 10th percentile ignores a stray double tick.
          this.peakFps = Math.max(this.peakFps, fps, refreshOf(s.deltas));
          s.deltas.length = 0;
          if (!skip) this.onFps(fps);
        }
      }
      s.last = ts;
      // `onFps` may have stopped it.
      if (this.sampler === s) s.id = raf(tick);
    };
    s.id = raf(tick);
  }

  private stopSampler(): void {
    const s = this.sampler;
    if (!s) return;
    this.sampler = null;
    this.smooth = 0;
    this.caf?.(s.id);
  }

  // One window measured. Slow: shrink to 70% of what animates. Smooth for SMOOTH_WINDOWS in a row: grow.
  private onFps(fps: number): void {
    const budget = this.animatingBudget;
    let next = this.adaptiveN;
    // A slower display (30 Hz low power) lowers the bar; a faster one does not raise it: 40 fps on a 120 Hz
    // screen is still slow, and 60 is smooth enough to give frames back.
    const k = Math.min(1, (this.peakFps > 0 ? this.peakFps : REFERENCE_HZ) / REFERENCE_HZ);
    if (fps < SLOW_FPS * k) {
      this.smooth = 0;
      const lowered = Math.max(MIN_ANIMATING, Math.floor(this.animatingIds.size * 0.7));
      // A slow window never raises the budget.
      if (lowered < budget) next = lowered;
    } else if (fps > SMOOTH_FPS * k) {
      if (++this.smooth >= SMOOTH_WINDOWS && this.adaptiveN < this.opts.maxAnimating) {
        this.smooth = 0;
        next = Math.ceil(this.adaptiveN * 1.25) + 2;
        // Past everything that could animate, or past the ceiling: the limit is gone.
        if (next >= Math.min(this.opts.maxAnimating, this.candidates)) next = Infinity;
      }
    } else this.smooth = 0;
    if (next === this.adaptiveN) return;
    this.adaptiveN = next;
    this.rerank();
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────
  // `cull`: the card left the view, so the picture is its last frame at full size rather than a small one.
  // Returns false when there is nothing to ask for.
  private requestSnapshot(id: ElementId, f: Frame, cull = false): boolean {
    const el = this.store.get(id);
    if (!el || el.w <= 0 || el.h <= 0) return false;
    // Sharp at the biggest the card gets while frozen (short side FREEZE_HYSTERESIS x freezePx, in device px),
    // whatever the zoom is now; at most SNAPSHOT_MAX_SIDE on the long side. A card that left the view comes
    // back at any size, so it gets the most there is.
    const dpr = this.doc.defaultView?.devicePixelRatio || 1;
    const k = Math.min(
      cull ? 2 * dpr : (this.opts.freezePx * FREEZE_HYSTERESIS * dpr) / Math.min(el.w, el.h),
      SNAPSHOT_MAX_SIDE / Math.max(el.w, el.h),
    );
    const seq = ++this.snapSeq;
    const w = Math.max(1, Math.round(el.w * k));
    const h = Math.max(1, Math.round(el.h * k));
    f.snap = { id: seq, timer: setTimeout(() => this.snapshotFailed(f, seq), SNAPSHOT_WAIT_MS), w, h, cull };
    this.snapping++;
    // `vw` x `vh`: the size the page is laid out at, for a frame whose window reports none (hidden).
    this.post(f, { cb: EMBED_CB, op: 'snapshot', id: seq, w, h, vw: f.w, vh: f.h }, '*');
    return true;
  }

  // Forgets the request in flight (a reply to it is ignored) and the wait for a poster.
  private cancelSnapshot(f: Frame): void {
    if (f.snap) {
      clearTimeout(f.snap.timer);
      f.snap = null;
      this.snapping--;
    }
    if (f.landTimer !== null) clearTimeout(f.landTimer);
    f.landTimer = null;
  }

  private snapshotFailed(f: Frame, seq: number): void {
    if (f.snap?.id !== seq) return;
    const cull = f.snap.cull;
    this.cancelSnapshot(f);
    // A failed last-frame snapshot costs nothing but the poster: no retries, and the freeze logic is not told.
    if (cull) this.finishCull(f);
    else this.markSnapFailed(f);
  }

  // A busy page can miss a snapshot that would work a moment later: try again, a few times, further apart.
  private markSnapFailed(f: Frame): void {
    f.snapFailed = true;
    if (++f.snapTries < SNAP_TRIES && f.retry === null) {
      f.retry = setTimeout(() => {
        f.retry = null;
        if (this.disposed) return;
        f.snapFailed = false;
        this.requestPlan();
      }, SNAP_RETRY_MS * f.snapTries);
    }
    // The next in the queue.
    this.requestPlan();
  }

  private onMessage(e: MessageEvent): void {
    const d = e.data as { cb?: unknown; op?: unknown; id?: unknown; ok?: unknown; blob?: unknown; svg?: unknown } | null;
    if (this.disposed || !d || typeof d !== 'object' || d.cb !== EMBED_CB) return;
    if (d.op === 'painted') {
      for (const f of this.frames.values()) {
        if (e.source === f.iframe.contentWindow && f.reveal?.id === d.id) return this.endReveal(f);
      }
      return;
    }
    if (d.op !== 'snapshot') return;
    for (const [id, f] of this.frames) {
      // Only the frame this layer mounted, and only the answer to the request it is waiting for.
      if (e.source !== f.iframe.contentWindow || !f.snap || f.snap.id !== d.id) continue;
      if (d.ok === false) return this.snapshotFailed(f, f.snap.id);
      // The frame's markup, drawn here; or a picture it drew itself.
      if (typeof d.svg === 'string' && d.svg !== '') {
        const { w, h, cull } = f.snap;
        const entry = this.entries.get(id);
        this.cancelSnapshot(f);
        // The frame has done its part: it can be hidden while the picture is drawn here.
        if (cull) this.finishCull(f);
        // The next in the queue may ask while this one is drawn.
        this.requestPlan();
        void this.rasterize(d.svg, w, h).then((blob) => {
          if (this.disposed || this.frames.get(id) !== f || this.entries.get(id) !== entry) return;
          if (!blob || blob.size === 0) return cull ? undefined : this.markSnapFailed(f);
          this.showSnapshot(id, f, blob, cull);
        });
        return;
      }
      if (!(d.blob instanceof Blob) || d.blob.size === 0) return this.snapshotFailed(f, f.snap.id);
      const blob = d.blob;
      const cull = f.snap.cull;
      this.cancelSnapshot(f);
      if (cull) this.finishCull(f);
      this.showSnapshot(id, f, blob, cull);
      // The next in the queue.
      this.requestPlan();
      return;
    }
  }

  private showSnapshot(id: ElementId, f: Frame, blob: Blob, cull = false): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (cull) {
      // The card came back while it was drawn: the frame shows, and a new texture would only flash the placeholder.
      if (!f.culled) f.cullSnapAt = -Infinity;
      // Not frozen: the frame is hidden for being off screen, and shows again with its card.
      else this.applyPoster(id, entry, URL.createObjectURL(blob), 'snapshot');
      return;
    }
    if (!f.small) return;
    this.applyPoster(id, entry, URL.createObjectURL(blob), 'snapshot');
    this.awaitPoster(id, f, 0);
  }

  // Hides the frame once the poster under it shows. The stage swaps textures a frame or more after the poster
  // changes, and hiding the frame before that shows the placeholder.
  private awaitPoster(id: ElementId, f: Frame, tries: number): void {
    f.landTimer = setTimeout(
      () => {
        f.landTimer = null;
        if (this.disposed || this.frames.get(id) !== f || !f.small) return;
        if (this.posterShown(id)) {
          this.setFrozen(f, true);
          this.syncPause(id, f, false);
        } else if (tries + 1 < LAND_TRIES) this.awaitPoster(id, f, tries + 1);
        else f.snapFailed = true;
      },
      tries === 0 ? LAND_FIRST_MS : LAND_STEP_MS,
    );
  }

  // The card's sprite shows a rendition of its poster (not the placeholder or the ThumbHash).
  private posterShown(id: ElementId): boolean {
    const v = this.stage.viewOf(id);
    return v !== null && v.variant === 'media' && (v as MediaView).shown >= 1;
  }

  // ── Interact mode ──────────────────────────────────────────────────────────
  // Fits the card, but never below the zoom a frame mounts at: a card too big for that (a 600x4000 page on
  // a short screen) is centred at that zoom instead.
  private flyIn(id: ElementId): void {
    const cam = this.stage.cam;
    const r = this.stage.contentBounds([id]);
    const w = Math.min(r.x1 - r.x0, Math.max(1, cam.width - FLY_PAD * 2) / FLY_IN_SCALE);
    const h = Math.min(r.y1 - r.y0, Math.max(1, cam.height - FLY_PAD * 2) / FLY_IN_SCALE);
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    this.stage.fitRect({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }, true, FLY_PAD);
  }

  // `flown`: the camera has already flown in for this card, so it does not fly again.
  private activate(id: ElementId, keyboard: boolean, flown = false): boolean {
    const entry = this.entries.get(id);
    const el = this.store.get(id);
    if (!entry || !el || !entry.ready) return false;
    if (this.interactId === id) return true;
    if (entry.spec === null) {
      // A bookmark: the page cannot be framed.
      if (entry.info.url !== '') window.open(entry.info.url, '_blank', 'noopener,noreferrer');
      return true;
    }
    if (this.stage.cam.scale < MIN_LIVE_SCALE) {
      // Too far out to mount anything: fly in, then interact once the camera settles (once: a camera that
      // cannot get in far enough, say a low maxScale, gives up).
      if (flown) return false;
      this.pendingInteract = id;
      this.flyIn(id);
      return true;
    }
    if (this.interactId !== null) this.exitInteract();
    entry.lastUsed = ++this.clock;
    this.interactId = id;
    this.runPlan(true);
    const f = this.frames.get(id);
    if (!f) {
      this.interactId = null;
      return false;
    }
    f.wrapper.dataset.interact = '';
    this.done.style.display = 'block';
    this.place(id, f);
    if (keyboard) this.done.focus({ preventScroll: true });
    this.emit('embedInteract', { id, active: true });
    return true;
  }
}

// A frame count: whole, never negative (Infinity stays).
const normBudget = (n: number): number => (Number.isNaN(n) ? Infinity : Math.max(0, Math.floor(n)));

function originOf(u: string | undefined): string {
  try {
    return u === undefined ? '' : new URL(u).origin;
  } catch {
    return '';
  }
}

// The refresh rate a window's frame intervals show (0: too few to tell), at most 240 Hz.
function refreshOf(deltas: readonly number[]): number {
  if (deltas.length < 10) return 0;
  const d = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length * 0.1)];
  return d > 0 ? Math.min(240, 1000 / d) : 0;
}

// An SVG drawn on a white canvas at w x h, as WebP. An SVG image runs no script and loads nothing; it does
// not taint the canvas in Chromium. null where it cannot be drawn (Safari taints it).
async function rasterizeSvg(doc: Document, svg: string, w: number, h: number): Promise<Blob | null> {
  try {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const c = doc.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/webp', 0.85));
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
