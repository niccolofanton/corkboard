// The embed layer of a corkboard: poster resolution and the live iframes of `embed` cards.
//
//   poster   always. The card is a textured sprite like any other (generated tile, provider thumbnail or
//            the host's picture), through the LOD pipeline. No DOM. What this layer generates (tile, photo it
//            fetched, snapshot, preview) is a runtime override on the stage (`setPosterOverride`), never written
//            to the store: a host that saves the board does not save dead blob URLs, and swapping one picture for
//            another does not flash the placeholder.
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
//            per CULL_SNAPSHOT_MIN_MS), never takes the slots freezing needs, is skipped while the camera moves
//            fast (the frame is hidden at once) and is drawn here when the browser is idle. Nothing is revealed
//            on the way back: the wrapper is transparent once the frame has loaded (`data-ready`), so the poster
//            under it shows until the frame paints. The same goes for a frozen frame thawing.
//   frozen   a snippet frame whose card is small on screen (under `freezePx`) and idle: it is asked for a
//            snapshot of its own document (bootstrap.ts), the picture becomes the card's poster, and once that
//            texture shows the frame is hidden (`data-frozen`, `display: none`, so it stops rendering while its
//            document stays alive). It keeps its place in the live / parked budgets, and shows again the moment
//            the card grows past 1.4x `freezePx`, is selected or enters interact mode. The size is `freezePx`
//            raised (up to 4x) while the page stays slow with the budget at its floor, and lowered back when it is
//            smooth (`freezeThreshold`). A snapshot that fails
//            (a tainted canvas, Safari, a timeout) leaves the frame live: never a generic tile for a card that
//            has been live. The poster that is left is the last frame, which is also what shows if the frame
//            is destroyed later.
//   Life of a card: poster -> live -> parked -> culled -> destroyed (back to its poster).
//   preview  a snippet card that has not been live has only a generated tile. A small pool of hidden "studio"
//            iframes (`previewWorkers`, 2) renders such snippets in the background, one job per frame: load,
//            wait PREVIEW_SETTLE_MS so it animates into a representative state, ask for a snapshot (the same
//            protocol as freezing), draw it here and make it the card's poster (`ownKind` 'preview'). Jobs are
//            ordered on screen first, nearest the centre, and only start while the camera is still. The studio
//            sits at the top-left of the page at opacity 0, not off screen: Chromium throttles frames that are
//            out of the viewport (no requestAnimationFrame), which would leave a canvas snippet blank. It is
//            laid out like a live frame (same virtual screen and aspect), has the same sandbox, and takes no
//            loading or snapshot slot. A preview never covers a snapshot of a live frame and is never covered
//            by a tile. Pictures are cached by a hash of what shapes them (previewCache.ts): in memory, and
//            across reloads in Cache Storage, where a hit needs no job at all.
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
//            their last frame. N is `maxAnimating` at most, and with `adaptive` the board's frame-rate
//            monitor (render/frameRate.ts: short bursts of rAF sampling on events that change the load, plus a
//            heartbeat, never a loop that keeps the page awake) lowers it when the page runs under SLOW_FPS and
//            raises it back when it is smooth. Pages that cannot be paused (plain URLs, Spotify, CodePen, Figma) take no slot and are
//            never touched. Ranked on settle and on selection, interaction or budget changes, not every frame.
//            Mounting is not affected: every card in view still mounts. At the floor, a page that is still slow
//            freezes bigger cards too (see frozen): hiding frames is what frees the most.
//   interact the iframe takes pointer events (double-click or Enter on a selected embed). A "Done" button,
//            a click outside the iframe or Esc ends it. Until then the canvas keeps pan, zoom, select and
//            drag: the iframe has `pointer-events: none`.
//
// What goes in the iframe (sandbox, allow list) is decided at mount time by sandbox.ts, never stored.
import type { Camera } from '../math';
import type { Stage } from '../render/stage';
import type { Store, StoreEvent } from '../store';
import type { Theme } from '../render/theme';
import { elementBox } from '../interact/geometry';
import { FrameRateMonitor, SMOOTH_WINDOWS, type FrameWindow } from '../render/frameRate';
import type { Card, CardId, EmbedResolution, EmbedSource } from '../types';
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
import type { BoardErrorEvent } from '../errors';
import { PreviewStore, previewKey, previewMaterial, type PreviewCacheMode } from './previewCache';
import { iframeSpecFor, normalizeIsolatedHosts, type IframeSpec, type SnippetNetwork } from './sandbox';
import { drawTile, tileSpec } from './tile';
import { acquireStyle } from '../styles';

/**
 * Options of the embed layer (`CorkboardOptions.embeds`, `board.embeds.setOptions()`). Numeric limits accept `Infinity` for
 * "no cap". A page is a live iframe only while its card is in view and within these limits; the rest show their poster.
 */
export interface EmbedOptions {
  /**
   * Live iframes at once on a mouse / pen device.
   * @default 12
   */
  maxLive?: number;
  /**
   * Live iframes at once on a touch device.
   * @default 3
   */
  maxLiveTouch?: number;
  /**
   * Mounted iframes at once (live + parked) on a mouse / pen device.
   * @default 24
   */
  maxMounted?: number;
  /**
   * Mounted iframes at once (live + parked) on a touch device.
   * @default 6
   */
  maxMountedTouch?: number;
  /**
   * Mounted iframes kept while their card is off screen (culled: hidden, not rendering, but alive), a subset of
   * `maxMounted`, on a mouse / pen device. The most recently seen stay; the rest are destroyed when the camera
   * settles. `Infinity`: only `maxMounted` limits them.
   * @default 64
   */
  maxOffscreen?: number;
  /**
   * The same as `maxOffscreen`, on a touch device.
   * @default 12
   */
  maxOffscreenTouch?: number;
  /**
   * How far past the viewport a card still counts as on screen, as a fraction of the viewport on each side. Frames in
   * that ring keep rendering, and cards entering it mount ahead of the pan.
   * @default 0.5
   */
  cullMargin?: number;
  /**
   * A card goes live when it is at least this big on screen, in CSS px, or selected. Default 0: any card in view, up
   * to `maxLive`, the biggest on screen first. A number is the width; the height keeps a 320:200 ratio.
   */
  minLivePx?: number | { w: number; h: number };
  /**
   * Below this zoom no new iframe mounts. Interacting still flies in to a zoom of 0.25.
   * @default 0 (any zoom)
   */
  minLiveScale?: number;
  /**
   * Async lookup for what the browser cannot know: oEmbed thumbnails and titles, og:image, screenshots,
   * and whether the page may be framed at all. Runs on a server of yours. See EmbedResolver. A failed or
   * timed-out lookup is reported through the `error` event (kind 'embed') and the card falls back to what the
   * URL says. `setOptions` takes it too (it cannot be unset): it applies to lookups started afterwards; cards
   * already resolved keep their result.
   */
  resolve?: EmbedResolver;
  /**
   * Give up on `resolve` after this long, ms, and use what the URL says. `board.embeds.setOptions` changes it for lookups started afterwards.
   * @default 4000
   */
  resolveTimeoutMs?: number;
  /**
   * The virtual screen a live page is laid out at; a card's `embed.resolution` wins.
   * @default '720p'
   */
  resolution?: EmbedResolution;
  /**
   * Keep `allow-same-origin` in the sandbox of arbitrary (non-provider) URLs. Many sites break without their own
   * cookies and storage, but the frame then keeps its real origin across the navigations it makes. `false`: those
   * frames get an opaque origin. Providers and snippets are not affected.
   * @default true
   */
  arbitrarySameOrigin?: boolean;
  /**
   * Hosts whose frames never get `allow-same-origin` (opaque origin: no cookies, no storage), whatever the
   * profile. Each entry is normalised once: a bare host (`example.com`, `bücher.de`, `.example.com`,
   * `*.example.com`, `example.com:443`, `::1`) or a full URL (its host is taken); case, port, a trailing dot and
   * punycode do not matter. A URL matches a domain entry when its host equals it or is a subdomain of it
   * (`example.com`, `.example.com` and `*.example.com` all cover `app.example.com`). An IP literal (v4 or v6)
   * matches exactly that address and is never a suffix. A blank entry matches nothing; an entry with a path,
   * credentials or a query, or that cannot be parsed, throws `CorkboardError` (`'invalid'`) from the constructor
   * or `setOptions`. Judged by the URL the frame starts with only: a redirect, or a link followed in interact
   * mode, can land on a host that is not listed. Changing it remounts the frames it affects.
   */
  isolatedHosts?: readonly string[];
  /**
   * What a snippet (`embed.html`) may load: `'images'` is pictures and fonts over https, which are still requests
   * to any server; `'none'` is only `data:` and `blob:`: no subresource request (image, font, `fetch`...) is
   * allowed. It is advisory, not isolation: a snippet can still navigate its own frame
   * (`location.href = 'https://x/leak?...'`), and that request always leaves (its URL can carry data out); the CSP and
   * the sandbox cannot stop a self-navigation. The page that answers is not under the snippet CSP either, except
   * in Chromium, which enforces the CSP on the pages the frame navigates to (the iframe `csp` attribute) and does not
   * run them; on other engines it runs for as long as it likes. The layer's navigation guard (see `error`) only
   * catches accidents, such as a link clicked in interact mode. Only serving snippets from a separate origin would
   * isolate. Applies to frames mounted after the change; a frame that is already live keeps the policy it was mounted with.
   * @default 'images'
   */
  snippetNetwork?: SnippetNetwork;
  /**
   * Start YouTube and Vimeo videos playing on their own, muted and looping, as soon as their card goes live. Changing it remounts the live frames. Snippets run their own scripts either way.
   * @default false
   */
  autoplay?: boolean;
  /**
   * Iframes loading at once. New frames mount in chunks, nearest the centre of the view first, as earlier ones
   * finish, so a board full of embeds does not start hundreds of pages in the same frame. A frame that has not
   * loaded after 8 s gives its slot up. `Infinity`: no limit.
   * @default 6
   */
  maxLoading?: number;
  /**
   * A mounted card whose short side on screen drops under this many CSS px is not worth rendering. A snippet frame is
   * frozen: it is snapshotted into the card's poster and hidden. A YouTube / Vimeo frame is paused. Both come back above
   * 1.4x this size, when selected or in interact mode. `0`: neither freezing nor size-based pausing (parked and culled frames are still paused).
   * @default 140
   */
  freezePx?: number;
  /**
   * At most this many mounted, visible frames that can be paused (snippets, YouTube / Vimeo) animate at once; the
   * rest are paused, showing their last frame, biggest on screen and nearest the centre first. Pages that cannot be
   * paused (plain URLs, Spotify, CodePen, Figma) are not counted.
   * @default Infinity
   */
  maxAnimating?: number;
  /**
   * Lower the number of animating frames while the page runs under 40 fps, and raise it back (up to `maxAnimating`) when it is smooth again. `false`: always `maxAnimating`.
   * @default true
   */
  adaptive?: boolean;
  /**
   * Hidden frames that render snippets which have not been live, to give their cards a real picture instead of a generated tile. `0`: none, the tile stays until the card goes live.
   * @default 3
   */
  previewWorkers?: number;
  /**
   * Where those pictures are kept: `'memory'` is this page only. `'persistent'` also keeps them in Cache Storage (at
   * most 1000, oldest dropped first), so a reload shows them at once; it leaves pictures of the snippets on the
   * visitor's disk, hence opt-in. Falls back to memory where Cache Storage cannot be used, or in an insecure context
   * (entries are named by a SHA-256, which needs `crypto.subtle`). `{ persistent: true, name }` uses the Cache Storage
   * entry `name` instead of the default `corkboard-previews-v2`. `Corkboard.clearPreviewCache(name?)` empties it.
   * @default 'memory'
   */
  previewCache?: PreviewCacheMode;
}

/** The embed layer's events, on the board's `on()` (see `CorkboardEvents`). */
export interface EmbedEvents {
  /** Interact mode began (`active: true`) or ended on an embed card. */
  embedInteract: { id: CardId; active: boolean };
  /** A card's iframe was mounted (`live: true`) or destroyed. */
  embedLive: { id: CardId; live: boolean };
  /**
   * A card's embed was resolved. `poster` is a URL worth persisting (the host's own or a provider thumbnail), absent for a
   * generated tile or any blob URL this layer made (they die with the page).
   */
  embedResolved: {
    id: CardId;
    provider: EmbedProvider;
    frameable: boolean;
    aspect?: number;
    title?: string;
    poster?: string;
  };
  /**
   * Something failed at runtime (`kind: 'embed'`): the resolver threw or timed out, or a snippet kept navigating its
   * frame away from its document (3 times within 10 s; each time the layer put its document back, and now the card
   * stays on its poster and `info()` says `blocked`). The navigation guard is best effort against accidents, such as a
   * link clicked in interact mode: it is not a security boundary (see `snippetNetwork`). The card keeps working on its
   * fallback (URL-derived info, or its poster).
   */
  error: BoardErrorEvent;
}

/** What the embed layer is given by the board. */
export interface EmbedLayerDeps {
  // The DOM layer shared with the other overlays (covers the canvas, `pointer-events: none`).
  root: HTMLElement;
  // The board's host: Enter on it enters interact mode.
  host: HTMLElement;
  store: Store;
  stage: Stage;
  emit<K extends keyof EmbedEvents>(type: K, payload: EmbedEvents[K]): void;
  // `nonce` of the injected <style> (a CSP with a nonce-based `style-src`).
  nonce?: string;
  // The board's frame-rate monitor, shared with the video layer. Without one the layer makes its own.
  frameRate?: FrameRateMonitor;
  // The frame scheduler of that own monitor (default: the window's). A seam for tests.
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
  // The blob URL of the poster this layer made (photo, tile, snapshot or preview): a stage override, not in the store.
  ownUrl: string | null;
  ownKind: 'photo' | 'tile' | 'snapshot' | 'preview' | null;
  // Our earlier posters the element may still carry (the embed changed under it).
  stale: Set<string>;
  initialAspect: number;
  lastUsed: number;
  // Last time the card was on screen (inside the cull margin), from the same counter as lastUsed.
  lastSeen: number;
  // Preview queue state of a snippet card. idle: not looked at, or nothing to do; checking: asking the
  // persistent cache; queued: waits for a studio; running: in a studio; done / failed: over.
  pv: 'idle' | 'checking' | 'queued' | 'running' | 'done' | 'failed';
  // A snippet whose frame kept navigating away from its document (see `guardLoad`): it never goes live again
  // (until its content changes, which makes a new entry).
  blocked: boolean;
  // Jobs that ended without a picture.
  pvTries: number;
  // The key of its preview when it was queued (jobs on the same one are not run side by side).
  pvKey: string;
}

// A hidden iframe that renders one snippet at a time for its preview.
interface Studio {
  box: HTMLElement;
  // A new iframe per job (null until the first): a document that is still loading when its job ends can
  // never be taken for the next job's.
  iframe: HTMLIFrameElement | null;
  job: PreviewJob | null;
}

interface PreviewPlan {
  key: string;
  material: string;
  // The virtual screen the snippet is laid out at, and the size of its picture.
  vw: number;
  vh: number;
  w: number;
  h: number;
}

interface PreviewJob {
  id: CardId;
  entry: Entry;
  token: number;
  studio: Studio | null;
  plan: PreviewPlan;
  // The request in flight (0: not asked yet).
  seq: number;
  loaded: boolean;
  settle: ReturnType<typeof setTimeout> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Frame {
  wrapper: HTMLElement;
  iframe: HTMLIFrameElement;
  loaded: boolean;
  // The corner radius last written, in the wrapper's px.
  radius: number;
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
  // The reply is in and its picture is being drawn here: the frame is not asked again until it is applied
  // (the snapshot slot is already free for the others).
  drawing: boolean;
  // Snippet navigation guard (see `guardLoad`): the window the iframe had at the last accepted load, when the
  // layer last put the document back (its next load is that document, not a navigation), and the times of the
  // strikes (Date.now()) still within NAV_STRIKE_MS.
  win: Window | null;
  restoring: boolean;
  strikes: number[];
  // Snippet: the last op sent (true: pause). Video: this layer paused the player.
  paused: boolean;
  // The user has had the frame in interact mode, so a video in it may be playing without autoplay.
  interacted: boolean;
  // Resends the video command once the player has had time to start listening.
  loadTimer: ReturnType<typeof setTimeout> | null;
  // Ranked past the animating budget: paused like a parked frame (never set on a frame that cannot be paused).
  overBudget: boolean;
}

// A snippet's frame that loads something other than its own document is given its document back; this many times
// within NAV_STRIKE_MS and the card is blocked (until its content changes) and an `error` is emitted.
export const NAV_STRIKES = 3;
export const NAV_STRIKE_MS = 10_000;
export const MAX_LOADING = 6;
export const LOAD_SLOT_MS = 8000;
/**
 * A card counts as on screen this far outside the viewport too (fraction of the viewport, each side), so frames
 * just past the edge stay visible and a small pan does not hide and show them.
 */
export const CULL_MARGIN = 0.5;
/**
 * Under this short side on screen (CSS px) a frame is frozen or paused, and above FREEZE_HYSTERESIS times it
 * it comes back, so a card hovering around the size does not flip.
 */
export const FREEZE_PX = 140;
export const FREEZE_HYSTERESIS = 1.4;
/**
 * While the page stays slow with the animating budget at its floor, the size under which snippets freeze is
 * raised by FREEZE_STEP per slow window, up to FREEZE_MAX_MUL x `freezePx`, and lowered back the same way.
 */
export const FREEZE_STEP = 1.5;
export const FREEZE_MAX_MUL = 4;
/** Snapshots asked for at once: each is main-thread work in the frame. */
export const MAX_SNAPSHOTS = 6;
/** A frame that leaves the view is hidden once its snapshot is in, or this long after it was asked for. */
export const CULL_SNAPSHOT_MS = 400;
/** At most one such snapshot per frame in this time, so panning back and forth does not redo the work. */
export const CULL_SNAPSHOT_MIN_MS = 3000;
// ... and only while this many of the MAX_SNAPSHOTS slots are free, so freezing is never starved.
const CULL_SNAPSHOT_RESERVE = 2;
/**
 * No snapshot on the way out while the camera moves faster than this (screen px per ms): the frame is hidden at
 * once, the pan is not slowed down by main-thread work for pictures nobody will look at.
 */
export const CULL_SNAPSHOT_MAX_SPEED = 1.5;
// A frame gap longer than this is idle time, not a measure of speed.
const SPEED_MAX_DT_MS = 100;
// The picture of a cull snapshot is drawn when the browser is idle, or at the latest this long after.
const CULL_DRAW_IDLE_MS = 1000;
// A reply is awaited a bit longer than the frame's own time box.
const SNAPSHOT_WAIT_MS = SNAPSHOT_MS;
// A failed snapshot is tried again this much later (times the tries so far), this many times in all.
const SNAP_RETRY_MS = 2000;
const SNAP_TRIES = 3;
// After a snapshot poster is applied: the first look at whether its texture shows, then every step, up to
// LAND_TRIES times. The stage keeps the old poster on screen until the new one's first level is resident, so a
// level read sooner is the old one (stage.posterShown tells).
const LAND_FIRST_MS = 200;
const LAND_STEP_MS = 100;
const LAND_TRIES = 30;
/** The animating budget never adapts below this many frames. */
export const MIN_ANIMATING = 6;
/**
 * fps is read by the board's FrameRateMonitor (render/frameRate.ts, in bursts); under SLOW_FPS the budget
 * shrinks to 70% of what animates, and after SMOOTH_WINDOWS in a row over SMOOTH_FPS it grows by a quarter (+2).
 */
export { SAMPLE_WINDOW_MS, SLOW_FPS, SMOOTH_FPS, SMOOTH_WINDOWS } from '../render/frameRate';
// A video player is sent its command again this long after the frame loaded (the first may be too early).
const PLAYER_READY_MS = 1500;

/**
 * Previews: a snippet is asked for its picture this long after it loaded (so it has moved on from its first
 * frame), a job is given up after PREVIEW_JOB_MS, and drawing the reply after PREVIEW_DRAW_MS. A card gets at
 * most PREVIEW_TRIES jobs.
 */
export const PREVIEW_WORKERS = 3;
export const PREVIEW_SETTLE_MS = 400;
export const PREVIEW_JOB_MS = 4000;
const PREVIEW_DRAW_MS = 3000;
const PREVIEW_TRIES = 2;
// The aspect (height / width) a preview is laid out at is rounded to 1/PREVIEW_BUCKETS, so cards of nearly the
// same shape share a picture. Its layout box is PREVIEW_BOX wide before the virtual screen is applied.
const PREVIEW_BUCKETS = 50;
const PREVIEW_BOX = 1000;
// Out of the way, yet inside the viewport and visible to the browser (see the header).
const STUDIO_CSS = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none;z-index:-1;overflow:hidden;';

const STYLE_ID = 'cb-embed-styles';
const CSS = `
.cb-embed{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden;background:rgba(0,0,0,.28);pointer-events:none;container-type:size;transition:background-color .2s ease}
.cb-embed[data-ready]{background:transparent}
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
const SHEET = {
  selector: `style#${STYLE_ID}`,
  mark: (el: HTMLStyleElement): void => {
    el.id = STYLE_ID;
  },
  css: CSS,
};

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

/** The live iframes of the embed cards: mounting, limits, parking, freezing, previews and interact mode. The board owns one; reach it with `getInternals`. */
export class EmbedLayer {
  private readonly root: HTMLElement;
  private readonly host: HTMLElement;
  private readonly store: Store;
  private readonly stage: Stage;
  private readonly emit: EmbedLayerDeps['emit'];
  private readonly doc: Document;
  private readonly entries = new Map<CardId, Entry>();
  private readonly frames = new Map<CardId, Frame>();
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
    isolatedHosts: readonly string[];
    snippetNetwork: SnippetNetwork;
    autoplay: boolean;
    maxLoading: number;
    freezePx: number;
    maxAnimating: number;
    adaptive: boolean;
    previewWorkers: number;
  };
  private selected = new Set<CardId>();
  private touch = false;
  private moving = false;
  private planDirty = false;
  private interactId: CardId | null = null;
  // Double-click on a card too small to mount (zoomed far out): fly to it, then interact.
  private pendingInteract: CardId | null = null;
  private clock = 0;
  private snapSeq = 0;
  // Snapshot requests in flight.
  private snapping = 0;
  private disposed = false;
  private readonly monitor: FrameRateMonitor;
  private readonly rasterize: (svg: string, w: number, h: number) => Promise<Blob | null>;
  // The adaptive limit on animating frames (Infinity: none); the effective budget also honours maxAnimating.
  private adaptiveN = Infinity;
  private animatingIds = new Set<CardId>();
  // Frames that were candidates for a slot at the last ranking, and how many mounted frames render (on screen,
  // not culled, not frozen): the monitor only measures while there are any, and is poked when the count moves.
  private candidates = 0;
  private renderCount = 0;
  // A frame froze or thawed since the last ranking.
  private rankDirty = false;
  private smooth = 0;
  // `freezePx` x this is the size under which a snippet freezes (1..FREEZE_MAX_MUL); smooth windows in a row.
  private freezeMul = 1;
  private freezeSmooth = 0;
  // How fast the camera moved at the last frame (screen px per ms), from the previous camera state.
  private camSpeed = 0;
  private lastCam: { tx: number; ty: number; scale: number; at: number } | null = null;
  private readonly studios: Studio[] = [];
  private readonly previews: PreviewStore;
  // Entries that may need a preview have not all been looked at.
  private previewScan = false;
  // Jobs whose reply is being drawn (they hold no studio).
  private readonly drawing = new Set<PreviewJob>();

  constructor(deps: EmbedLayerDeps, options: EmbedOptions = {}) {
    this.host = deps.host;
    this.store = deps.store;
    this.stage = deps.stage;
    this.emit = deps.emit;
    this.doc = deps.root.ownerDocument;
    const win = this.doc.defaultView;
    this.monitor = deps.frameRate ?? new FrameRateMonitor({ raf: deps.raf, caf: deps.caf, doc: this.doc });
    if (!deps.frameRate) this.cleanups.push(() => this.monitor.dispose());
    this.cleanups.push(
      this.monitor.load(() => this.opts.adaptive && !this.disposed && this.renderCount > 0),
      this.monitor.onWindow((w) => this.onWindow(w)),
      // A new burst: the windows before it are no "in a row" with the ones to come.
      this.monitor.onStart(() => {
        this.smooth = 0;
        this.freezeSmooth = 0;
      }),
    );
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
      isolatedHosts: normalizeIsolatedHosts(options.isolatedHosts),
      snippetNetwork: options.snippetNetwork ?? 'images',
      autoplay: options.autoplay ?? false,
      maxLoading: options.maxLoading ?? MAX_LOADING,
      freezePx: options.freezePx ?? FREEZE_PX,
      maxAnimating: normBudget(options.maxAnimating ?? Infinity),
      adaptive: options.adaptive ?? true,
      previewWorkers: normWorkers(options.previewWorkers ?? PREVIEW_WORKERS),
    };
    this.previews = new PreviewStore(options.previewCache ?? 'memory');

    this.cleanups.push(acquireStyle(this.doc, SHEET, deps.nonce));
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
    const onVisibility = (): void => this.pumpPreviews();
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
  get live(): ReadonlySet<CardId> {
    return new Set(this.frames.keys());
  }

  // ... of which these are parked: mounted but inert, showing their last frame.
  get parked(): ReadonlySet<CardId> {
    const out = new Set<CardId>();
    for (const [id, f] of this.frames) if (f.wrapper.dataset.parked !== undefined) out.add(id);
    return out;
  }

  // ... and of those, these are off screen: hidden (`data-culled`), not rendering, still alive.
  get culled(): ReadonlySet<CardId> {
    const out = new Set<CardId>();
    for (const [id, f] of this.frames) if (f.culled) out.add(id);
    return out;
  }

  // ... and these are frozen: a snapshot is their poster and the frame is hidden (`data-frozen`), alive.
  get frozen(): ReadonlySet<CardId> {
    const out = new Set<CardId>();
    for (const [id, f] of this.frames) if (f.frozen) out.add(id);
    return out;
  }

  // ... and of those, these animate: they can be paused and are within the animating budget. A page that
  // cannot be paused is never in it (it takes no slot), nor is a parked, culled or frozen frame.
  get animating(): ReadonlySet<CardId> {
    const out = new Set<CardId>();
    for (const id of this.animatingIds) if (this.frames.has(id)) out.add(id);
    return out;
  }

  // How many frames may animate now: maxAnimating, lowered by the frame-rate monitor's windows (Infinity: no limit).
  get animatingBudget(): number {
    return Math.min(this.opts.maxAnimating, this.adaptiveN);
  }

  // The short side (CSS px) under which a snippet freezes now: `freezePx`, raised while the page stays slow
  // with the animating budget at its floor.
  get freezeThreshold(): number {
    return this.opts.freezePx * this.freezeMul;
  }

  // Ids of the cards whose iframe is mounted and still loading (the spinner shows).
  get loading(): ReadonlySet<CardId> {
    const out = new Set<CardId>();
    for (const [id, f] of this.frames) if (!f.loaded) out.add(id);
    return out;
  }

  // The card in interact mode (null: none).
  get interacting(): CardId | null {
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
  // A blocked snippet (see `guardLoad`) says so, and that it is not frameable; a content change clears it.
  info(id: CardId): Readonly<ResolvedEmbed> | null {
    const e = this.entries.get(id);
    if (!e) return null;
    return e.blocked ? Object.freeze({ ...e.info, frameable: false, blocked: true }) : e.info;
  }

  get resolution(): EmbedResolution {
    return this.opts.resolution;
  }

  // Snippet previews not done yet: waiting, being looked up in the cache or being rendered in a studio.
  get previewsPending(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.pv === 'checking' || e.pv === 'queued' || e.pv === 'running') n++;
    return n;
  }

  setOptions(o: EmbedOptions): void {
    // First: an invalid list throws before anything else is applied.
    const isolated = o.isolatedHosts === undefined ? undefined : normalizeIsolatedHosts(o.isolatedHosts);
    if (o.maxLive !== undefined) this.opts.maxLive = o.maxLive;
    if (o.maxLoading !== undefined) this.opts.maxLoading = o.maxLoading;
    if (o.freezePx !== undefined) this.opts.freezePx = Math.max(0, o.freezePx);
    if (o.maxAnimating !== undefined) this.opts.maxAnimating = normBudget(o.maxAnimating);
    if (o.adaptive !== undefined && o.adaptive !== this.opts.adaptive) {
      this.opts.adaptive = o.adaptive;
      // Off: back to the ceiling.
      if (!o.adaptive) {
        this.adaptiveN = Infinity;
        this.freezeMul = 1;
        this.requestPlan();
      }
      this.smooth = 0;
      this.freezeSmooth = 0;
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
    if (o.resolve !== undefined) this.opts.resolve = o.resolve;
    if (o.resolveTimeoutMs !== undefined) this.opts.resolveTimeoutMs = o.resolveTimeoutMs;
    const sandboxChanged = o.arbitrarySameOrigin !== undefined && o.arbitrarySameOrigin !== this.opts.arbitrarySameOrigin;
    const autoplayChanged = o.autoplay !== undefined && o.autoplay !== this.opts.autoplay;
    const isolatedChanged = isolated !== undefined && !sameList(isolated, this.opts.isolatedHosts);
    const networkChanged = o.snippetNetwork !== undefined && o.snippetNetwork !== this.opts.snippetNetwork;
    if (sandboxChanged || autoplayChanged || isolatedChanged || networkChanged) {
      if (o.arbitrarySameOrigin !== undefined) this.opts.arbitrarySameOrigin = o.arbitrarySameOrigin;
      if (o.autoplay !== undefined) this.opts.autoplay = o.autoplay;
      if (isolated !== undefined) this.opts.isolatedHosts = isolated;
      if (o.snippetNetwork !== undefined) this.opts.snippetNetwork = o.snippetNetwork;
      for (const [id, e] of this.entries) {
        if (!e.ready) continue;
        const before = e.spec;
        e.spec = this.specFor(e);
        // A live frame is rebuilt with the new sandbox or URL the next time it mounts. A snippet's document
        // (its CSP) is not: a live snippet keeps the policy it loaded with, only frames mounted later get the new one.
        if ((e.spec?.sandbox !== before?.sandbox || e.spec?.src !== before?.src) && this.frames.has(id)) {
          this.destroyFrame(id);
        }
      }
    }
    if (o.previewCache !== undefined) this.previews.mode = o.previewCache;
    if (o.previewWorkers !== undefined) {
      const workers = normWorkers(o.previewWorkers);
      if (workers === 0 && this.opts.previewWorkers > 0) this.stopPreviews();
      this.opts.previewWorkers = workers;
      this.previewScan = true;
    }
    this.rerank();
    this.requestPlan();
    // A limit or the adaptive switch moved: the load is measured again (or not at all).
    this.monitor.poke();
  }

  // Interact mode on a card: make it live (whatever its size) and give it pointer events. A card the page
  // refuses to frame opens its URL in a new tab instead. Returns false when there is nothing to do.
  interact(id: CardId): boolean {
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
  setSelection(ids: readonly CardId[]): void {
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

  onDblClick(id: CardId | null): void {
    if (id !== null && this.entries.has(id)) this.activate(id, false);
  }

  // Generated tiles follow the theme.
  setTheme(): void {
    for (const [id, e] of this.entries) if (e.ownKind === 'tile') void this.makeTile(id, e, e.token);
  }

  onFrame(camChanged: boolean): void {
    if (this.disposed) return;
    if (camChanged) this.moving = true;
    this.trackSpeed();
    // One stamp per frame: whatever is in view now was seen at this tick, so the order of leaving is known.
    const view = this.cullRect();
    const seen = ++this.clock;
    for (const [id, f] of this.frames) this.place(id, f, view, seen);
    if (!this.moving && this.planDirty) this.runPlan();
    // Only a frame that froze or thawed asks for it here; everything else ranks on settle.
    else if (this.rankDirty) this.rerank();
    if (!this.moving && this.previewScan) this.scanPreviews();
  }

  // How far the view moved on screen since the last frame, per ms: where the point that was at the centre is
  // now, plus what a zoom moves at the corners. A frame less than a ms after the last keeps the reading; after
  // a gap (nothing was drawn) the previous camera is no measure, so the camera counts as slow for that frame.
  private trackSpeed(): void {
    const c = this.stage.cam;
    const cur = { tx: c.cam.tx, ty: c.cam.ty, scale: c.scale, at: Date.now() };
    const prev = this.lastCam;
    this.lastCam = cur;
    if (!prev) return;
    const dt = cur.at - prev.at;
    if (dt <= 0) return;
    if (dt > SPEED_MAX_DT_MS) {
      this.camSpeed = 0;
      return;
    }
    const cx = c.width / 2;
    const cy = c.height / 2;
    const dx = ((cx - prev.tx) / prev.scale) * cur.scale + cur.tx - cx;
    const dy = ((cy - prev.ty) / prev.scale) * cur.scale + cur.ty - cy;
    const zoom = Math.abs(cur.scale / prev.scale - 1) * Math.hypot(cx, cy);
    this.camSpeed = (Math.hypot(dx, dy) + zoom) / dt;
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
    // The queue was held while the camera moved: it goes on, nearest the new view first.
    if (this.previewScan) this.scanPreviews();
    else this.pumpPreviews();
  }

  dispose(): void {
    if (this.disposed) return;
    this.exitInteract();
    this.disposed = true;
    this.stopPreviews();
    this.previews.clear();
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
    // A shared monitor stops if this layer was the last thing it was measuring for.
    this.monitor.poke();
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
    this.previewScan = true;
  }

  private untrack(id: CardId): void {
    if (this.frames.has(id)) this.destroyFrame(id);
    if (this.interactId === id) this.exitInteract();
    const e = this.entries.get(id);
    if (!e) return;
    e.token++;
    this.abortPreview(e);
    // The element may live on as another kind; a removed one drops its override with it.
    if (this.store.get(id)) this.stage.setPosterOverride(id, null);
    if (e.ownUrl) this.retire(e.ownUrl);
    for (const u of e.stale) this.retire(u);
    this.entries.delete(id);
  }

  private trackCurrent(id: CardId): void {
    const el = this.store.get(id);
    if (el) this.track(el);
  }

  private track(el: Card): void {
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
      // The host gave the card a picture of its own, or took it away again: which poster shows follows.
      this.syncOverride(el.id, prev);
      return;
    }
    const stale = new Set<string>();
    if (prev) {
      if (this.frames.has(el.id)) this.destroyFrame(el.id);
      if (this.interactId === el.id) this.exitInteract();
      prev.token++;
      this.abortPreview(prev);
      if (prev.ownUrl) stale.add(prev.ownUrl);
      for (const u of prev.stale) stale.add(u);
    }
    // Our earlier posters stay under the card until the new one lands, unless the host brought a picture.
    if (prev && !this.needsPoster(el.id)) {
      this.stage.setPosterOverride(el.id, null);
      for (const u of stale) this.retire(u);
      stale.clear();
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
      blocked: false,
      pv: 'idle',
      pvTries: 0,
      pvKey: '',
    };
    this.entries.set(el.id, entry);
    // No resolver: what the URL says is final, and the card can go live at once.
    if (!this.opts.resolve || info.kind === 'html' || info.url === '') this.settle(entry);
    void this.resolve(el.id, entry);
  }

  // The card's own title wins over the resolver's. Redraws a generated tile with the new one.
  private retitle(id: CardId, entry: Entry): void {
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
    this.previewScan = true;
    this.requestPlan();
  }

  private specFor(entry: Entry): IframeSpec | null {
    if (!canGoLive(entry.info)) return null;
    const spec = iframeSpecFor({
      source: entry.embed,
      iframeSrc: entry.info.iframeSrc ?? undefined,
      appOrigin: this.appOrigin,
      arbitrarySameOrigin: this.opts.arbitrarySameOrigin,
      isolatedHosts: this.opts.isolatedHosts,
      snippetNetwork: this.opts.snippetNetwork,
    });
    // Only the URL the iframe loads changes; `entry.info` keeps the plain one.
    if (spec?.src !== undefined) {
      spec.src = withJsApi(spec.provider, spec.src, this.appOrigin);
      if (this.opts.autoplay) spec.src = withAutoplay(spec.provider, spec.src);
    }
    return spec;
  }

  private async resolve(id: CardId, entry: Entry): Promise<void> {
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
          if (alive()) this.emit('error', { kind: 'embed', id, url: entry.info.url, cause: err });
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
      this.store.update(id, { h: Math.max(1, Math.round(el.w * a)) }, 'system');
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
  private needsPoster(id: CardId): boolean {
    const src = this.store.get(id)?.media.src;
    return src === undefined || src.startsWith('blob:');
  }

  // Returns the candidate URL that became the poster, null for a generated tile.
  private async loadPoster(id: CardId, entry: Entry, token: number): Promise<string | null> {
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

  private async makeTile(id: CardId, entry: Entry, token: number): Promise<void> {
    const el = this.store.get(id);
    if (!el) return;
    const theme: Theme = this.stage.activeTheme;
    const blob = await drawTile(tileSpec(entry.info), el.w > 0 ? el.h / el.w : 0.5625, theme);
    if (!blob) return;
    if (this.disposed || this.entries.get(id) !== entry || entry.token !== token) return;
    this.applyPoster(id, entry, URL.createObjectURL(blob), 'tile');
  }

  private applyPoster(id: CardId, entry: Entry, url: string, kind: 'photo' | 'tile' | 'snapshot' | 'preview'): void {
    // A late tile or photo never covers a real picture of the snippet: the last frame of a card that went live,
    // or its preview. A preview never covers that last frame either.
    const real = entry.ownKind === 'snapshot' || entry.ownKind === 'preview';
    if (kind !== 'snapshot' && (kind === 'preview' ? entry.ownKind === 'snapshot' : real)) {
      URL.revokeObjectURL(url);
      return;
    }
    if (!this.store.get(id)) {
      URL.revokeObjectURL(url);
      return;
    }
    const prev = entry.ownUrl;
    entry.ownUrl = url;
    entry.ownKind = kind;
    this.syncOverride(id, entry);
    if (prev) this.retire(prev);
    for (const u of entry.stale) this.retire(u);
    entry.stale.clear();
  }

  // The poster this layer made is a runtime override on the stage, never written to the store (its URL dies
  // with the page, and a store change per snapshot would reach the host's listeners and its autosave). A
  // picture of the host's in `media.src` wins over a tile or provider photo, not over a real picture of the
  // snippet (a snapshot or preview).
  private syncOverride(id: CardId, entry: Entry): void {
    if (entry.ownUrl === null) return;
    const real = entry.ownKind === 'snapshot' || entry.ownKind === 'preview';
    this.stage.setPosterOverride(id, real || this.needsPoster(id) ? entry.ownUrl : null);
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
        frameable: entry.spec !== null && !entry.blocked,
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
  private byPriority(ids: readonly CardId[]): CardId[] {
    if (ids.length < 2) return [...ids];
    const v = this.stage.cam.visibleRect();
    const cx = (v.x0 + v.x1) / 2;
    const cy = (v.y0 + v.y1) / 2;
    const rank = new Map<CardId, number>();
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

  private mountFrame(id: CardId): void {
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
    // Chromium refuses to run, in this frame, a page that does not accept the snippet's CSP (see IframeSpec.csp).
    if (spec.csp !== undefined) iframe.setAttribute('csp', spec.csp);
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
      radius: NaN,
      transform: '',
      z: NaN,
      culled: false,
      cullTimer: null,
      cullSnapAt: -Infinity,
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
      drawing: false,
      paused: false,
      win: null,
      restoring: false,
      strikes: [],
      interacted: false,
      loadTimer: null,
      overBudget: false,
    };
    frame.slotTimer = setTimeout(() => this.releaseSlot(frame), LOAD_SLOT_MS);
    // Runs for every navigation of the iframe (a page that follows a link, a snippet's frame reloaded because the
    // host moved the board in the DOM), and each one is a new document: it knows nothing of what the previous one
    // was told or asked.
    iframe.addEventListener('load', () => {
      // A snippet's document is its `srcdoc`, which reloads as itself. Whatever else loads (a `location`
      // assignment, a meta refresh, a link) is not the document the CSP and the bootstrap were written for: it is
      // replaced by that document again (see `guardLoad`). The `about:blank` load of a frame this layer already
      // destroyed is not looked at.
      if (frame.kind === 'snippet' && this.frames.get(id) === frame && !this.guardLoad(id, entry, frame)) return;
      frame.loaded = true;
      // Transparent from here on (the iframe fades in): the poster under it shows until the page paints.
      wrapper.dataset.ready = '';
      this.releaseSlot(frame);
      // So `syncPause` sends again what the new document should be doing. A frozen frame stays frozen (its
      // picture is still the poster); a snapshot request of the old document is dropped.
      frame.paused = false;
      this.dropRequest(frame);
      frame.snapFailed = false;
      frame.snapTries = 0;
      if (frame.retry !== null) clearTimeout(frame.retry);
      frame.retry = null;
      if (frame.loadTimer !== null) clearTimeout(frame.loadTimer);
      frame.loadTimer = null;
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
    this.frames.set(id, frame);
    entry.lastUsed = ++this.clock;
    this.place(id, frame);
    this.root.insertBefore(wrapper, this.done);
    this.emit('embedLive', { id, live: true });
  }

  // The navigation guard, run for each `load` of a snippet's frame. true: the load is the snippet's own document.
  //
  // Best effort against accidents (a link clicked in interact mode, a stray `location` assignment), not a security
  // boundary: no frame-level signal says which document loaded (a navigation during parse means our `srcdoc` never
  // fires `load` at all, and a page that never finishes loading fires none), so a hostile snippet can run another
  // page in its frame for as long as it likes. Chromium does not run such a page (the `csp` attribute), other
  // engines do.
  //  - the first load, a load with a new `contentWindow` (the host moved the board in the DOM: a reparented
  //    iframe is a new browsing context that reloads its `srcdoc`), and the load of the document this layer put
  //    back are accepted;
  //  - any other load is a navigation: the `srcdoc` is assigned again (the frame loads its own document back)
  //    and it counts as a strike; NAV_STRIKES within NAV_STRIKE_MS block the card.
  private guardLoad(id: CardId, entry: Entry, f: Frame): boolean {
    const win = f.iframe.contentWindow;
    if (f.win === null || win !== f.win) {
      f.win = win;
      f.restoring = false;
      return true;
    }
    if (f.restoring) {
      f.restoring = false;
      return true;
    }
    const now = Date.now();
    f.strikes = f.strikes.filter((t) => now - t < NAV_STRIKE_MS);
    f.strikes.push(now);
    if (f.strikes.length >= NAV_STRIKES) this.blockSnippet(id, entry);
    else {
      f.restoring = true;
      f.iframe.srcdoc = f.iframe.srcdoc;
    }
    return false;
  }

  private blockSnippet(id: CardId, entry: Entry): void {
    if (this.disposed || this.entries.get(id) !== entry) return;
    entry.blocked = true;
    this.destroyFrame(id);
    this.emit('error', { kind: 'embed', id, cause: new Error('snippet navigated away from its document') });
    this.requestPlan();
  }

  private destroyFrame(id: CardId): void {
    const f = this.frames.get(id);
    if (!f) return;
    this.frames.delete(id);
    this.animatingIds.delete(id);
    if (f.slotTimer !== null) clearTimeout(f.slotTimer);
    if (f.loadTimer !== null) clearTimeout(f.loadTimer);
    if (f.retry !== null) clearTimeout(f.retry);
    if (f.cullTimer !== null) clearTimeout(f.cullTimer);
    f.cullTimer = null;
    this.cancelSnapshot(f);
    if (this.interactId === id) this.exitInteract();
    // Navigate away first so the page (and its process) is released, then drop the node.
    f.iframe.removeAttribute('srcdoc');
    f.iframe.src = 'about:blank';
    f.wrapper.remove();
    // Back to its poster: if that is a tile, it can have a preview now.
    this.previewScan = true;
    this.emit('embedLive', { id, live: false });
  }

  // Writes size and transform only when they changed.
  // `view`: the cull rect (computed once per frame by the caller); `seen`: stamp for cards in view.
  private place(id: CardId, f: Frame, view: Rect = this.cullRect(), seen = 0): void {
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
    // The card's corner radius is in world px, the wrapper is laid out in its own px (a 720p virtual screen):
    // scaled, so the frame's corners are the poster's corners.
    const radius = Math.round((((this.store.get(id)?.radius ?? 0) * p.width) / Math.max(r.w, 1)) * 100) / 100;
    if (radius !== f.radius) {
      f.radius = radius;
      s.borderRadius = `${radius}px`;
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
  private cull(id: CardId, f: Frame): void {
    if (!this.canSnapCull(id, f) || !this.requestSnapshot(id, f, true)) {
      f.wrapper.dataset.culled = '';
      return;
    }
    f.wrapper.dataset.culling = '';
    f.cullTimer = setTimeout(() => this.finishCull(f), CULL_SNAPSHOT_MS);
    f.cullSnapAt = Date.now();
  }

  private canSnapCull(id: CardId, f: Frame): boolean {
    return (
      f.kind === 'snippet' &&
      f.loaded &&
      !f.frozen &&
      !f.snap &&
      !f.drawing &&
      f.landTimer === null &&
      this.camSpeed < CULL_SNAPSHOT_MAX_SPEED &&
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

  // The card is back. A frame still waiting to be hidden never was.
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
    delete f.wrapper.dataset.culled;
  }

  // ── Freeze and pause ───────────────────────────────────────────────────────
  // Decides what a mounted frame does with its card's size, selection and parking. Cheap enough to run on
  // every frame for every frame: it writes and posts only when something changed.
  private tune(id: CardId, f: Frame, r: { w: number; h: number } | undefined, settled: boolean): void {
    const held = this.interactId === id || this.selected.has(id);
    if (this.interactId === id) f.interacted = true;
    const px = this.freezeThreshold;
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
      !f.drawing &&
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
    if (frozen) f.wrapper.dataset.frozen = '';
    else delete f.wrapper.dataset.frozen;
  }

  // Sends a snippet its pause / resume, or a video player its pause / play, when what it should be doing
  // changed. `force` repeats the pause to a player that may not have been listening yet.
  private syncPause(id: CardId, f: Frame, force: boolean): void {
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
    const ranked: { id: CardId; f: Frame; tier: number; area: number; dist: number }[] = [];
    let renderCount = 0;
    for (const [id, f] of this.frames) {
      if (!f.culled && !f.frozen) renderCount++;
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
    const animating = new Set<CardId>();
    ranked.forEach((c, i) => {
      const over = i >= budget;
      if (!over) animating.add(c.id);
      this.setOverBudget(c.id, c.f, over);
    });
    this.animatingIds = animating;
    this.candidates = ranked.length;
    // Frames mounted, destroyed, culled, frozen or thawed: the load changed, so it is measured again.
    if (renderCount !== this.renderCount) {
      this.renderCount = renderCount;
      this.monitor.poke();
    }
  }

  private setOverBudget(id: CardId, f: Frame, over: boolean): void {
    if (over === f.overBudget) return;
    f.overBudget = over;
    this.syncPause(id, f, false);
  }

  // One window measured. Slow: shrink to 70% of what animates. Smooth for SMOOTH_WINDOWS in a row: grow.
  private onWindow(w: FrameWindow): void {
    if (!this.opts.adaptive || this.disposed) return;
    const budget = this.animatingBudget;
    let next = this.adaptiveN;
    if (w.slow) {
      this.smooth = 0;
      this.adaptFreeze(true);
      const lowered = Math.max(MIN_ANIMATING, Math.floor(this.animatingIds.size * 0.7));
      // A slow window never raises the budget.
      if (lowered < budget) next = lowered;
    } else if (w.smooth) {
      this.adaptFreeze(false);
      if (++this.smooth >= SMOOTH_WINDOWS && this.adaptiveN < this.opts.maxAnimating) {
        this.smooth = 0;
        next = Math.ceil(this.adaptiveN * 1.25) + 2;
        // Past everything that could animate, or past the ceiling: the limit is gone.
        if (next >= Math.min(this.opts.maxAnimating, this.candidates)) next = Infinity;
      }
    } else {
      this.smooth = 0;
      this.adaptFreeze(null);
    }
    if (next === this.adaptiveN) return;
    this.adaptiveN = next;
    this.rerank();
    // The budget moved: what that does to the page is measured next.
    this.monitor.poke();
  }

  // Hiding frames is what frees the most, so once the animating budget cannot go lower and windows are still
  // slow, bigger snippets freeze too (FREEZE_STEP x per slow window, up to FREEZE_MAX_MUL x `freezePx`). The same
  // steps back down after SMOOTH_WINDOWS smooth windows in a row. `null`: a window in between, neither.
  private adaptFreeze(slow: boolean | null): void {
    if (this.opts.freezePx <= 0) return;
    let mul = this.freezeMul;
    if (slow === true) {
      this.freezeSmooth = 0;
      if (this.animatingBudget <= MIN_ANIMATING) mul = Math.min(FREEZE_MAX_MUL, mul * FREEZE_STEP);
    } else if (slow === false) {
      if (++this.freezeSmooth >= SMOOTH_WINDOWS && mul > 1) {
        this.freezeSmooth = 0;
        mul = Math.max(1, mul / FREEZE_STEP);
      }
    } else this.freezeSmooth = 0;
    if (mul === this.freezeMul) return;
    this.freezeMul = mul;
    // Every frame is looked at again against the new size.
    this.requestPlan();
    this.monitor.poke();
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────
  // `cull`: the card left the view, so the picture is its last frame at full size rather than a small one.
  // Returns false when there is nothing to ask for.
  private requestSnapshot(id: CardId, f: Frame, cull = false): boolean {
    const el = this.store.get(id);
    if (!el || el.w <= 0 || el.h <= 0) return false;
    // Sharp at the biggest the card gets while frozen (short side FREEZE_HYSTERESIS x the freeze size, in device px),
    // whatever the zoom is now; at most SNAPSHOT_MAX_SIDE on the long side. A card that left the view comes
    // back at any size, so it gets the most there is.
    const dpr = this.doc.defaultView?.devicePixelRatio || 1;
    const k = Math.min(
      cull ? 2 * dpr : (this.freezeThreshold * FREEZE_HYSTERESIS * dpr) / Math.min(el.w, el.h),
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

  // Forgets the request in flight: a reply to it is ignored.
  private dropRequest(f: Frame): void {
    if (!f.snap) return;
    clearTimeout(f.snap.timer);
    f.snap = null;
    this.snapping--;
  }

  // ... and the wait for a poster.
  private cancelSnapshot(f: Frame): void {
    this.dropRequest(f);
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
    const d = e.data as { cb?: unknown; op?: unknown; id?: unknown; ok?: unknown; svg?: unknown } | null;
    if (this.disposed || !d || typeof d !== 'object' || d.cb !== EMBED_CB) return;
    if (d.op !== 'snapshot') return;
    for (const s of this.studios) {
      const job = s.job;
      if (!job || job.seq !== d.id || e.source !== s.iframe?.contentWindow) continue;
      if (!validSvg(d)) return this.previewFailed(job);
      return this.previewReply(job, d.svg);
    }
    for (const [id, f] of this.frames) {
      // Only the frame this layer mounted, and only the answer to the request it is waiting for.
      if (e.source !== f.iframe.contentWindow || !f.snap || f.snap.id !== d.id) continue;
      if (!validSvg(d)) return this.snapshotFailed(f, f.snap.id);
      // The frame's markup, drawn here.
      const svg = d.svg;
      const { w, h, cull } = f.snap;
      const entry = this.entries.get(id);
      this.cancelSnapshot(f);
      // The frame has done its part: it can be hidden while the picture is drawn here, and the next in the
      // queue may ask. This one is not asked again until its picture is applied (`drawing`).
      f.drawing = true;
      if (cull) this.finishCull(f);
      this.requestPlan();
      const draw = (): Promise<Blob | null> => Promise.resolve(this.rasterize(svg, w, h)).catch(() => null);
      const done = (blob: Blob | null): void => {
        f.drawing = false;
        if (this.disposed || this.frames.get(id) !== f || this.entries.get(id) !== entry) return;
        // A frame that was waiting for this picture is looked at again.
        this.requestPlan();
        if (!blob || blob.size === 0) return cull ? undefined : this.markSnapFailed(f);
        this.showSnapshot(id, f, blob, cull);
      };
      // A cull snapshot is a nicety for a card that is off screen: drawn when the browser has nothing better to do.
      if (cull) {
        this.whenIdle(() => {
          if (this.disposed || this.frames.get(id) !== f) done(null);
          else void draw().then(done);
        });
      } else void draw().then(done);
      return;
    }
  }

  private whenIdle(fn: () => void): void {
    const win = this.doc.defaultView;
    if (win && typeof win.requestIdleCallback === 'function') win.requestIdleCallback(fn, { timeout: CULL_DRAW_IDLE_MS });
    else setTimeout(fn, 0);
  }

  private showSnapshot(id: CardId, f: Frame, blob: Blob, cull = false): void {
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
  private awaitPoster(id: CardId, f: Frame, tries: number): void {
    if (f.landTimer !== null) clearTimeout(f.landTimer);
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

  // The card's sprite shows a rendition of its current poster (not the placeholder, the ThumbHash or the
  // poster it replaced, which stays on screen while the new one decodes).
  private posterShown(id: CardId): boolean {
    return this.stage.posterShown(id);
  }

  // ── Previews ───────────────────────────────────────────────────────────────
  // Whether a card's poster is still no real picture of its snippet, and nothing else is about to make one: a
  // snippet (not a page), not mounted, with a tile or nothing (a picture of the host's is left alone).
  private wantsPreview(id: CardId, entry: Entry): boolean {
    if (entry.info.kind !== 'html' || !entry.ready || entry.blocked || entry.spec?.srcdoc === undefined) return false;
    if (this.frames.has(id) || entry.ownKind === 'snapshot' || entry.ownKind === 'preview') return false;
    return entry.ownKind === 'tile' || this.needsPoster(id);
  }

  // What a card's preview is: the layout box a live frame would get at the card's aspect (bucketed, so cards of
  // the same shape share it), and the picture's size, as sharp as a frozen snapshot of it.
  private previewPlan(id: CardId, entry: Entry): PreviewPlan | null {
    const html = entry.embed.html;
    const el = this.store.get(id);
    if (html === undefined || !el || el.w <= 0 || el.h <= 0 || entry.blocked) return null;
    const bucket = Math.max(1, Math.round((el.h / el.w) * PREVIEW_BUCKETS));
    const rect = { x: 0, y: 0, w: PREVIEW_BOX, h: (PREVIEW_BOX * bucket) / PREVIEW_BUCKETS };
    const res = entry.embed.resolution ?? this.opts.resolution;
    const box = embedPlacement(rect, { tx: 0, ty: 0, scale: 1 }, res);
    const dpr = this.doc.defaultView?.devicePixelRatio || 1;
    const k = Math.min(
      (Math.max(this.opts.freezePx, FREEZE_PX) * FREEZE_HYSTERESIS * dpr) / Math.min(rect.w, rect.h),
      SNAPSHOT_MAX_SIDE / Math.max(rect.w, rect.h),
    );
    const w = Math.max(1, Math.round(rect.w * k));
    const h = Math.max(1, Math.round(rect.h * k));
    return {
      key: previewKey(html, bucket, String(res), w, h),
      material: previewMaterial(html, bucket, String(res), w, h),
      vw: box.width,
      vh: box.height,
      w,
      h,
    };
  }

  // Looks at the cards that may need a preview and have not been looked at: a picture already in the cache is
  // applied at once, the rest is queued.
  private scanPreviews(): void {
    this.previewScan = false;
    if (this.disposed || this.opts.previewWorkers <= 0) return;
    for (const [id, entry] of this.entries) {
      if (entry.pv !== 'idle' || !this.wantsPreview(id, entry)) continue;
      const plan = this.previewPlan(id, entry);
      if (!plan) continue;
      const hit = this.previews.getMemory(plan.key);
      entry.pvKey = plan.key;
      if (hit) this.applyPreview(id, entry, hit);
      else if (this.previews.persistent) this.lookupPreview(id, entry, plan.key, plan.material);
      else entry.pv = 'queued';
    }
    this.pumpPreviews();
  }

  private lookupPreview(id: CardId, entry: Entry, key: string, material: string): void {
    entry.pv = 'checking';
    const token = entry.token;
    void this.previews.getPersistent(material).then((blob) => {
      if (this.disposed || this.entries.get(id) !== entry || entry.token !== token || entry.pv !== 'checking') return;
      // Came from Cache Storage: not written back.
      if (blob) this.previews.put(key, blob);
      if (!this.wantsPreview(id, entry)) entry.pv = 'idle';
      else if (blob) this.applyPreview(id, entry, blob);
      else entry.pv = 'queued';
      this.pumpPreviews();
    });
  }

  private applyPreview(id: CardId, entry: Entry, blob: Blob): void {
    entry.pv = 'done';
    this.applyPoster(id, entry, URL.createObjectURL(blob), 'preview');
  }

  // Cards to render, best first: on screen, then nearest the centre of the view; a card that already failed once
  // goes after all the others.
  private nextPreview(): { id: CardId; entry: Entry } | null {
    const v = this.stage.cam.visibleRect();
    const cx = (v.x0 + v.x1) / 2;
    const cy = (v.y0 + v.y1) / 2;
    let best: { id: CardId; entry: Entry } | null = null;
    let bestRank = Infinity;
    // The same snippet on two cards is drawn once: the second waits for the first and then takes its picture.
    const busy = new Set<string>();
    for (const s of this.studios) if (s.job) busy.add(s.job.plan.key);
    for (const j of this.drawing) busy.add(j.plan.key);
    for (const [id, entry] of this.entries) {
      if (entry.pv !== 'queued' || busy.has(entry.pvKey)) continue;
      if (!this.wantsPreview(id, entry)) {
        // Went live or got a picture meanwhile; it is looked at again if it needs one later.
        entry.pv = 'idle';
        continue;
      }
      const r = this.stage.previewRectOf(id) ?? this.store.get(id);
      if (!r) continue;
      const on = overlaps(elementBox({ x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot }), v);
      const rank = entry.pvTries * 1e15 + (on ? 0 : 1e12) + Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
      if (rank < bestRank) {
        bestRank = rank;
        best = { id, entry };
      }
    }
    return best;
  }

  // Starts jobs on free studios while there are queued cards. Nothing starts while the camera moves, the tab is
  // hidden (it would not paint) or there are no workers; studios left without a job are removed.
  private pumpPreviews(): void {
    if (this.disposed) return;
    const go = !this.moving && this.opts.previewWorkers > 0 && this.doc.visibilityState !== 'hidden';
    while (go) {
      if (this.studios.filter((s) => s.job).length >= this.opts.previewWorkers) break;
      const next = this.nextPreview();
      if (!next) break;
      const plan = this.previewPlan(next.id, next.entry);
      if (!plan) {
        next.entry.pv = 'failed';
        continue;
      }
      // The same snippet was drawn while this one waited.
      const hit = this.previews.getMemory(plan.key);
      if (hit) {
        this.applyPreview(next.id, next.entry, hit);
        continue;
      }
      const studio = this.studios.find((s) => !s.job) ?? this.makeStudio();
      if (!studio) break;
      this.startPreview(studio, next.id, next.entry, plan);
    }
    for (const s of this.studios.filter((x) => !x.job)) this.removeStudio(s);
  }

  private makeStudio(): Studio | null {
    const body = this.doc.body;
    if (!body) return null;
    const box = this.doc.createElement('div');
    box.style.cssText = STUDIO_CSS;
    box.setAttribute('aria-hidden', 'true');
    box.setAttribute('inert', '');
    // The iframe is made by the job, before the box goes in: no empty document loads first.
    const studio: Studio = { box, iframe: null, job: null };
    this.studios.push(studio);
    return studio;
  }

  private removeStudio(s: Studio): void {
    const i = this.studios.indexOf(s);
    if (i >= 0) this.studios.splice(i, 1);
    s.job = null;
    if (s.iframe) {
      s.iframe.removeAttribute('srcdoc');
      s.iframe.src = 'about:blank';
    }
    s.box.remove();
  }

  private startPreview(studio: Studio, id: CardId, entry: Entry, plan: PreviewPlan): void {
    const spec = entry.spec;
    if (!spec || spec.srcdoc === undefined) return;
    const job: PreviewJob = { id, entry, token: entry.token, studio, plan, seq: 0, loaded: false, settle: null, timer: null };
    job.timer = setTimeout(() => this.previewFailed(job), PREVIEW_JOB_MS);
    entry.pv = 'running';
    studio.job = job;
    // A fresh iframe: the old one, with whatever it is still loading, is gone with its load event.
    const old = studio.iframe;
    if (old) {
      old.removeAttribute('srcdoc');
      old.src = 'about:blank';
      old.remove();
    }
    const ifr = this.doc.createElement('iframe');
    studio.iframe = ifr;
    ifr.tabIndex = -1;
    ifr.setAttribute('aria-hidden', 'true');
    ifr.style.cssText = 'border:0;display:block;';
    ifr.addEventListener('load', () => {
      // Only the load of this job's document, once.
      if (studio.job !== job || studio.iframe !== ifr || job.loaded) return;
      job.loaded = true;
      job.settle = setTimeout(() => this.askPreview(job), PREVIEW_SETTLE_MS);
    });
    // The same sandbox, CSP and bootstrap as a live frame.
    ifr.title = spec.title;
    ifr.setAttribute('sandbox', spec.sandbox);
    ifr.setAttribute('allow', spec.allow);
    ifr.setAttribute('referrerpolicy', spec.referrerPolicy);
    if (spec.csp !== undefined) ifr.setAttribute('csp', spec.csp);
    ifr.style.width = studio.box.style.width = `${plan.vw}px`;
    ifr.style.height = studio.box.style.height = `${plan.vh}px`;
    ifr.srcdoc = spec.srcdoc;
    studio.box.appendChild(ifr);
    if (!studio.box.isConnected) this.doc.body.appendChild(studio.box);
  }

  // Loaded and given time to move on from its first frame: ask for the picture.
  private askPreview(job: PreviewJob): void {
    job.settle = null;
    const s = job.studio;
    if (!s || s.job !== job) return;
    job.seq = ++this.snapSeq;
    const { plan } = job;
    try {
      s.iframe?.contentWindow?.postMessage({ cb: EMBED_CB, op: 'snapshot', id: job.seq, w: plan.w, h: plan.h, vw: plan.vw, vh: plan.vh }, '*');
    } catch {
      // The frame is gone: the job times out.
    }
  }

  private endJob(job: PreviewJob): void {
    if (job.settle !== null) clearTimeout(job.settle);
    if (job.timer !== null) clearTimeout(job.timer);
    job.settle = job.timer = null;
    if (job.studio?.job === job) job.studio.job = null;
    job.studio = null;
    this.drawing.delete(job);
  }

  private jobAlive(job: PreviewJob): boolean {
    return !this.disposed && this.entries.get(job.id) === job.entry && job.entry.token === job.token;
  }

  // No picture: the tile stays. One more try, after everything else.
  private previewFailed(job: PreviewJob): void {
    this.endJob(job);
    if (this.jobAlive(job)) {
      job.entry.pvTries++;
      job.entry.pv = job.entry.pvTries < PREVIEW_TRIES ? 'queued' : 'failed';
    }
    this.pumpPreviews();
  }

  // The frame answered: it is free for the next job while the markup is drawn here.
  private previewReply(job: PreviewJob, svg: string): void {
    this.endJob(job);
    const drawn = setTimeout(() => this.previewFailed(job), PREVIEW_DRAW_MS);
    job.timer = drawn;
    this.drawing.add(job);
    this.pumpPreviews();
    void Promise.resolve()
      .then(() => this.rasterize(svg, job.plan.w, job.plan.h))
      .catch(() => null)
      .then((blob) => {
        // Timed out meanwhile (the timer fired and requeued it): too late.
        if (job.timer !== drawn) return;
        this.endJob(job);
        if (!this.jobAlive(job)) return;
        if (!blob || blob.size === 0) return this.previewFailed(job);
        this.previews.put(job.plan.key, blob, job.plan.material);
        const { id, entry } = job;
        if (this.wantsPreview(id, entry)) this.applyPreview(id, entry, blob);
        else entry.pv = 'idle';
        this.pumpPreviews();
      });
  }

  // Drops the job of an entry that is going away (its card was removed or its embed changed).
  private abortPreview(entry: Entry): void {
    for (const s of this.studios) if (s.job?.entry === entry) this.endJob(s.job);
    for (const j of [...this.drawing]) if (j.entry === entry) this.endJob(j);
    entry.pv = 'idle';
    if (!this.disposed) this.pumpPreviews();
  }

  // No workers, or the end: jobs are dropped, studios removed, queued cards forgotten.
  private stopPreviews(): void {
    for (const s of [...this.studios]) {
      if (s.job) this.endJob(s.job);
      this.removeStudio(s);
    }
    for (const j of [...this.drawing]) this.endJob(j);
    for (const e of this.entries.values()) if (e.pv === 'checking' || e.pv === 'queued' || e.pv === 'running') e.pv = 'idle';
  }

  // ── Interact mode ──────────────────────────────────────────────────────────
  // Fits the card, but never below the zoom a frame mounts at: a card too big for that (a 600x4000 page on
  // a short screen) is centred at that zoom instead.
  private flyIn(id: CardId): void {
    const cam = this.stage.cam;
    const r = this.stage.boundsOf([id]);
    if (!r) return;
    const w = Math.min(r.x1 - r.x0, Math.max(1, cam.width - FLY_PAD * 2) / FLY_IN_SCALE);
    const h = Math.min(r.y1 - r.y0, Math.max(1, cam.height - FLY_PAD * 2) / FLY_IN_SCALE);
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    this.stage.fitRect({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }, true, FLY_PAD);
  }

  // `flown`: the camera has already flown in for this card, so it does not fly again.
  private activate(id: CardId, keyboard: boolean, flown = false): boolean {
    const entry = this.entries.get(id);
    const el = this.store.get(id);
    if (!entry || !el || !entry.ready) return false;
    if (this.interactId === id) return true;
    if (entry.blocked) return false;
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

/**
 * The most a snapshot reply may weigh, as the length of its SVG string (UTF-16 units, about 2 MB as sent): a
 * page that answers with more is treated as a failed snapshot instead of being parsed and drawn here.
 */
export const SNAPSHOT_MAX_SVG = 2 * 1024 * 1024;

const validSvg = (d: { ok?: unknown; svg?: unknown }): d is { svg: string } =>
  d.ok !== false && typeof d.svg === 'string' && d.svg !== '' && d.svg.length <= SNAPSHOT_MAX_SVG;

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// A number of studios: whole, never negative.
const normWorkers = (n: number): number => (Number.isNaN(n) ? PREVIEW_WORKERS : Math.min(8, Math.max(0, Math.floor(n))));

// A frame count: whole, never negative (Infinity stays).
const normBudget = (n: number): number => (Number.isNaN(n) ? Infinity : Math.max(0, Math.floor(n)));

function originOf(u: string | undefined): string {
  try {
    return u === undefined ? '' : new URL(u).origin;
  } catch {
    return '';
  }
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
