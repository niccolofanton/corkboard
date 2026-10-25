// Stage: the Pixi stage of a corkboard. One WebGL canvas, a world container that is a render group (the
// camera is its GPU transform), pooled views for the elements near the viewport, and an on-demand render
// loop: nothing runs while nothing moves (0 rAF callbacks, 0 % CPU idle).
//
//   store events + input ──► CameraController ──► rAF tick ──► (cull + LOD every 100 ms during a
//   gesture, exact on settle) ──► TextureManager uploads (<= 4 ms) ──► overlay ──► one render
//
// Design rules: Pixi's own ticker and event system are off, culling is ours (rbush in the store: only
// elements in the viewport plus a screen of overscan have a display object), and nothing but this loop
// touches the render path.
//
// Draw order: every view's `zIndex` is the element's rank in the store's draw order, and the world
// container sorts by it.
import { Application, Container, Texture, TilingSprite, Ticker, type WebGLRenderer } from 'pixi.js';
import type { Camera, Rect } from '../math';
import { elementBox, emptyBox, worldRectOf, type WorldRect } from '../interact/geometry';
import type { Box } from '../interact/geometry';
import type { ChangeSet, StoreEvent } from '../store';
import { DEFAULTS, MAX_SCALE, MIN_SCALE, type Element, type ElementId } from '../types';
import { CameraController } from './camera';
import { l2Bucket, l3Bucket, MAX_L3, pickLevel, type Level } from './lod';
import { OverlayLayer } from './overlay';
import { parkTicker } from './parkTicker';
import { FAR_DIST, TextureManager, type WantedItem } from './textures';
import { DARK_THEME, cssHex, type Theme } from './theme';
import type { BoardCard } from './types';
import { ViewPools, definitionOf } from './views/pool';
import { MediaView } from './views/mediaView';
import type { ElementView, ViewCtx } from './views/view';

// What the stage reads from the store (`Store` satisfies it structurally).
export interface StageStore {
  subscribe(listener: (e: StoreEvent) => void): () => void;
  get(id: ElementId): Element | undefined;
  elements(): IterableIterator<Element>;
  searchInto(box: Box, out: Element[]): Element[];
  rank(id: ElementId): number;
  readonly orderVersion: number;
}

export interface StageOptions {
  // Texture memory budget in bytes (default 256 MB; use ~128 MB on small devices).
  budgetBytes?: number;
  // Decode workers (default: a quarter of the cores, 1..4).
  workers?: number;
  // URL of the decode worker script, for pages whose CSP forbids `worker-src blob:` (the built-in worker is
  // inlined and started from a blob URL). Serve `corkboard/decode.worker` yourself and pass its URL here.
  workerUrl?: string | URL;
  softCanvas?: boolean;
  // Per-frame texture upload budget, ms (default 4).
  uploadBudgetMs?: number;
  // Overscan, as a fraction of the viewport added on every side (default 0.5).
  overscan?: number;
  // Wrap each render in an EXT_disjoint_timer_query_webgl2 query where the browser has one.
  gpuTimer?: boolean;
  theme?: Theme;
  // Show the background dot grid (default true).
  grid?: boolean;
  // Completed renders before a retired texture is destroyed (see retire.ts).
  retireDelay?: number;
  // Load Pixi's CSP-safe build (no `new Function`), for pages whose content security policy forbids eval.
  cspSafe?: boolean;
  // The zoom range of the camera (default 0.05..4). A board of thousands of world px wide that is fitted
  // whole needs a lower minimum.
  minScale?: number;
  maxScale?: number;
}

const LOD_INTERVAL_MS = 100;
const SETTLE_MS = 140;
// World px between background dots, also the grid cards snap to when grid snapping is on.
export const GRID = 24;
// How far past the viewport (fraction of its size) a card still counts as on screen.
const VIEW_MARGIN = 0.1;
// Time a tick may spend creating views for elements that entered the viewport (ms).
const MOUNT_BUDGET_MS = 5;
// The rounded corners are baked in texels from the card's world size, so a resize scales them too: the corner
// drawn is radius * long / bakedLong. Up to this far off (world px) is left alone; past it the card is baked
// again, which shows its placeholder for a moment. A square-cornered card never needs it.
const BAKE_CORNER_SLACK = 1;
// The textures are cropped to the card's height / width (cover): a ratio that moved by more than this fraction
// since the bake is baked again.
const BAKE_ASPECT_SLACK = 0.01;

const pct = (a: Float32Array, n: number, p: number): number => {
  if (n === 0) return 0;
  const s = Array.from(a.subarray(0, n)).sort((x, y) => x - y);
  return s[Math.min(n - 1, Math.floor((n - 1) * p))];
};
const r2 = (n: number): number => Math.round(n * 100) / 100;

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// The results of `contentBounds` that stand for "nothing there" (a fresh rect each, so the public API keeps
// its shape): a fit of one of them is a no-op instead of a zoom onto the origin.
const noContent = new WeakSet<Rect>();

// Base64 (standard or url-safe) -> bytes.
function decodeBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The camera's zoom range from the options: the defaults for anything missing or not a usable range.
function scaleBounds(o: Pick<StageOptions, 'minScale' | 'maxScale'>): { min: number; max: number } {
  const min = o.minScale !== undefined && o.minScale > 0 ? o.minScale : MIN_SCALE;
  const max = o.maxScale !== undefined && o.maxScale >= min ? o.maxScale : Math.max(MAX_SCALE, min);
  return { min, max };
}

// A preview / committed geometry in world space, owned by the stage while a gesture runs.
export type PreviewRect = WorldRect;

export class Stage {
  readonly app: Application;
  readonly world: Container;
  readonly overlay: OverlayLayer;
  readonly cam: CameraController;
  readonly tm: TextureManager;
  readonly pools = new ViewPools();
  private readonly renderer: WebGLRenderer;
  private readonly bg: TilingSprite;
  private readonly canvas: HTMLCanvasElement;
  private readonly opts: Required<
    Omit<
      StageOptions,
      'theme' | 'workers' | 'workerUrl' | 'retireDelay' | 'cspSafe' | 'grid' | 'minScale' | 'maxScale'
    >
  > & { workers: number; retireDelay?: number };
  private readonly ro: ResizeObserver;
  private readonly cleanups: (() => void)[] = [];
  private dpr: number;
  // The element the stage sits in: its page position is read when a pointer needs it (the page can
  // move it without resizing it), not only when it resizes.
  private readonly hostEl: HTMLElement;
  private theme: Theme;
  private showGrid: boolean;
  private readonly ctx: ViewCtx;

  // ── Scene ──
  private store: StageStore | null = null;
  private unsub: (() => void) | null = null;
  private readonly views = new Map<ElementId, ElementView>();
  private readonly mediaViews = new Set<MediaView>();
  private readonly hits: Element[] = [];
  // Elements that entered the mount window and wait for their view: mounting is time-budgeted per tick
  // (a zoom-out can bring thousands in at once), nearest first.
  private mountQueue: { id: ElementId; key: number }[] = [];
  private readonly queued = new Set<ElementId>();
  private queueSorted = true;
  private stamp = 0;
  private mountedWin: Rect | null = null;
  private mountedScale = 0;
  private orderSeen = -1;
  // Store changes waiting for the next tick.
  private pendingAdded = new Set<ElementId>();
  private pendingRemoved = new Map<ElementId, Element>();
  private pendingUpdated = new Map<ElementId, Set<string>>();
  private pendingReload = false;

  // ── Cards (texture slots) ──
  private slotOf = new Map<ElementId, number>();
  private freeSlots: number[] = [];
  private slotCount = 0;
  private slotCard: (BoardCard | null)[] = [];
  private slotView: (MediaView | null)[] = [];
  // Per slot: the level the card wants (0..3), whether it touches the viewport.
  private slotLevel: Int8Array = new Int8Array(64);
  private slotOnScreen: Uint8Array = new Uint8Array(64);
  private slotOwn: Uint8Array = new Uint8Array(64);
  // Per slot: the long side (world px) the card's textures were last baked at (see BAKE_CORNER_SLACK).
  private slotBaked: Float32Array = new Float32Array(64);
  // Per slot: the card's height / width the textures were cropped to (cover). 0 = none yet.
  private slotBakedAspect: Float32Array = new Float32Array(64);
  private l0Missing = 0;
  // Decoded ThumbHash bytes of base64 strings, by string.
  private readonly hashCache = new Map<string, Uint8Array>();

  // ── Overrides applied on top of the committed state ──
  private readonly previews = new Map<ElementId, PreviewRect>();
  private readonly hidden = new Set<ElementId>();
  private readonly alphas = new Map<ElementId, number>();
  // Elements that must stay mounted regardless of the window (previewed, being dragged).
  private readonly pinned = new Set<ElementId>();

  // ── Loop state ──
  private raf = 0;
  private lastTs = 0;
  private renderedVersion = -1;
  private dirty = true;
  private lodDirty = false;
  private lastLod = -1e9;
  private settleTimer = 0;
  private lost = false;
  private disposed = false;
  private beforeHooks: (() => void)[] = [];
  private frameHooks: ((camChanged: boolean) => void)[] = [];
  private settleHooks: (() => void)[] = [];
  // Hooks that threw and were already reported (once each: a hook that throws every frame must not flood).
  private readonly reportedHooks = new WeakSet<object>();
  // Watches the page's pixel ratio: a media query for the current value, re-armed after every change.
  private dprQuery: MediaQueryList | null = null;
  // Frames that threw and were healed by rebuilding the textures (never reset).
  private renderErrorsTotal = 0;
  // Which step of the tick is running (names the step in a recovered error).
  private where = 'idle';
  private rendersSinceRetire = 0;

  // ── Instrumentation ──
  private t0 = 0;
  private firstPaintMs: number | null = null;
  private l1CompleteMs: number | null = null;
  private counters = {
    renderErrors: 0,
    hookErrors: 0,
    rafCalls: 0,
    ticks: 0,
    renders: 0,
    cullPasses: 0,
    requeries: 0,
    lodPasses: 0,
    mounts: 0,
    unmounts: 0,
  };
  private readonly phase = { store: 0, camera: 0, upload: 0, overlay: 0, render: 0 };
  private slowTicks: Record<string, number>[] = [];
  private reqMs = { search: 0, mount: 0, unmount: 0, lod: 0 };
  private lodPassMs = new Float32Array(1024);
  private nLodPass = 0;
  private tickMs = new Float32Array(4096);
  private renderMs = new Float32Array(4096);
  private nTick = 0;
  private nRender = 0;
  private gpu: GpuTimer | null = null;
  private gpuMs = new Float32Array(4096);
  private nGpu = 0;

  static async create(host: HTMLElement, options: StageOptions = {}): Promise<Stage> {
    // Pixi's system ticker (its GC scheduler) would keep a rAF loop alive forever: park it, and put it back
    // the way the host had it when the board is disposed.
    const unpark = parkTicker(Ticker.system);
    try {
      return await Stage.createParked(host, options, unpark);
    } catch (err) {
      unpark();
      throw err;
    }
  }

  private static async createParked(
    host: HTMLElement,
    options: StageOptions,
    unpark: () => void,
  ): Promise<Stage> {
    if (options.cspSafe) await import('pixi.js/unsafe-eval');
    const app = new Application();
    const rect = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    await app.init({
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      resolution: dpr,
      autoDensity: true,
      antialias: false,
      backgroundColor: (options.theme ?? DARK_THEME).canvas,
      preference: 'webgl',
      powerPreference: 'high-performance',
      autoStart: false,
      sharedTicker: false,
      // Our own LRU owns texture lifetimes; Pixi's idle-time GC would unload atlas pages.
      gcActive: false,
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    Ticker.system.stop();
    app.ticker.stop();
    return new Stage(app, host, options, dpr, unpark);
  }

  private constructor(
    app: Application,
    host: HTMLElement,
    options: StageOptions,
    dpr: number,
    private readonly unparkTicker: () => void,
  ) {
    this.app = app;
    this.hostEl = host;
    this.dpr = dpr;
    this.theme = options.theme ?? DARK_THEME;
    this.showGrid = options.grid ?? true;
    this.renderer = app.renderer as WebGLRenderer;
    this.canvas = app.canvas as HTMLCanvasElement;
    this.opts = {
      budgetBytes: options.budgetBytes ?? 256 * 1024 * 1024,
      workers:
        options.workers ??
        Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 4))),
      uploadBudgetMs: options.uploadBudgetMs ?? 4,
      overscan: options.overscan ?? 0.5,
      gpuTimer: options.gpuTimer ?? false,
      softCanvas: options.softCanvas ?? false,
      retireDelay: options.retireDelay,
    };
    host.appendChild(this.canvas);
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';

    this.ctx = {
      theme: this.theme,
      dpr,
      scale: 1,
      wake: () => this.requestFrame(),
      invalidate: () => {
        this.dirty = true;
      },
    };

    this.bg = this.makeBackground();
    this.world = new Container({ isRenderGroup: true });
    this.world.sortableChildren = true;
    this.world.eventMode = 'none';
    this.overlay = new OverlayLayer(this.theme, () => this.requestFrame(), dpr);
    this.bg.eventMode = 'none';
    app.stage.eventMode = 'none';
    app.stage.addChild(this.bg, this.world, this.overlay.container);

    this.cam = new CameraController(() => this.requestFrame(), scaleBounds(options));
    this.tm = new TextureManager(this.renderer, {
      budgetBytes: this.opts.budgetBytes,
      workers: this.opts.workers,
      workerUrl: options.workerUrl,
      softCanvas: options.softCanvas,
      border: this.borderCss(),
      retireDelay: this.opts.retireDelay,
      onRetire: () => this.rebuildBatches(),
      onWake: () => this.requestFrame(),
    });
    this.tm.keep = (slot, level) =>
      level === 1
        ? this.slotOnScreen[slot] === 1
        : level === 2
          ? this.slotOwn[slot] >= 2
          : this.slotOwn[slot] === 3;
    if (this.opts.gpuTimer) this.gpu = GpuTimer.create(this.renderer);
    this.applyThemeToScene();

    const measure = (): void => {
      const r = host.getBoundingClientRect();
      const empty = Math.round(r.width) < 1 || Math.round(r.height) < 1;
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      // Browser zoom resizes the host too: take the pixel ratio along with the size.
      const dprChanged = this.setDpr(window.devicePixelRatio || 1);
      if (!dprChanged && w === this.cam.width && h === this.cam.height && empty === this.cam.isEmpty) {
        return;
      }
      this.renderer.resize(w, h, this.dpr);
      this.bg.width = w;
      this.bg.height = h;
      this.cam.setViewport(w, h, empty);
      this.mountedWin = null;
      this.dirty = true;
      // Resizing clears the drawing buffer: draw it again before the browser paints, or the canvas
      // shows a blank frame for every step of a resize that animates.
      if (ready && !this.lost && !this.disposed) this.render();
      this.requestFrame();
    };
    let ready = false;
    measure();
    ready = true;
    this.ro = new ResizeObserver(measure);
    this.ro.observe(host);
    this.bindContextLoss();
    this.watchDpr();
    this.cleanups.push(() => this.unwatchDpr());
  }

  // Adopts a new device pixel ratio (browser zoom, a window dragged to another screen). Returns whether it
  // changed. The LOD levels follow device px, so the cull window and the levels are asked for again.
  private setDpr(dpr: number): boolean {
    if (dpr === this.dpr) return false;
    this.dpr = dpr;
    this.ctx.dpr = dpr;
    this.overlay.setDpr(dpr);
    this.mountedWin = null;
    this.lodDirty = true;
    this.dirty = true;
    return true;
  }

  // A media query for the current ratio only fires when it stops matching, so it is armed again for the new
  // value after every change.
  private watchDpr(): void {
    this.unwatchDpr();
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(`(resolution: ${this.dpr}dppx)`);
    mq.addEventListener('change', this.onDprChange);
    this.dprQuery = mq;
  }

  private unwatchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = null;
  }

  private onDprChange = (): void => {
    if (this.disposed) return;
    const changed = this.setDpr(window.devicePixelRatio || 1);
    this.watchDpr();
    if (!changed) return;
    this.renderer.resize(this.cam.width, this.cam.height, this.dpr);
    // Resizing clears the drawing buffer (see `measure`).
    if (!this.lost) this.render();
    this.requestFrame();
  };

  get activeTheme(): Theme {
    return this.theme;
  }

  get canvasEl(): HTMLCanvasElement {
    return this.canvas;
  }

  // ── Store ──────────────────────────────────────────────────────────────────
  attach(store: StageStore): void {
    this.detach();
    this.store = store;
    this.unsub = store.subscribe((e) => this.onStoreEvent(e));
    this.reloadAll();
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
    this.store = null;
    this.clearViews();
  }

  private onStoreEvent(e: StoreEvent): void {
    if (e.type !== 'change') return;
    const c: ChangeSet = e.change;
    if (c.source === 'load') {
      // A full reload: rebuild from the store at the next tick.
      this.pendingReload = true;
      this.requestFrame();
      return;
    }
    for (const el of c.removed) {
      this.pendingAdded.delete(el.id);
      this.pendingUpdated.delete(el.id);
      this.pendingRemoved.set(el.id, el);
    }
    // An id removed and added again before the tick keeps its pending removal: the flush unmounts the old
    // view (and frees its slot) before it mounts the new element, so none of the old geometry or picture
    // survives into the new card.
    for (const el of c.added) this.pendingAdded.add(el.id);
    for (const u of c.updated) {
      if (this.pendingAdded.has(u.el.id)) continue;
      let set = this.pendingUpdated.get(u.el.id);
      if (!set) {
        set = new Set();
        this.pendingUpdated.set(u.el.id, set);
      }
      for (const p of u.props) set.add(p);
    }
    this.requestFrame();
  }

  // Applies the store changes that arrived since the last tick.
  private flushStore(): boolean {
    const store = this.store;
    if (!store) return false;
    let changed = false;
    if (this.pendingReload) {
      this.pendingReload = false;
      this.pendingAdded.clear();
      this.pendingRemoved.clear();
      this.pendingUpdated.clear();
      this.reloadAll();
      return true;
    }
    if (this.pendingRemoved.size > 0) {
      for (const [id, el] of this.pendingRemoved) {
        this.unmountId(id);
        if (definitionOf(el.kind).textured) this.freeSlot(id);
        this.previews.delete(id);
        this.hidden.delete(id);
        this.alphas.delete(id);
        this.pinned.delete(id);
      }
      this.pendingRemoved.clear();
      changed = true;
    }
    const win = this.mountedWin;
    if (this.pendingAdded.size > 0) {
      // Before the first cull pass there is no window to test against: the adds wait in the mount queue,
      // which that pass (this same tick) filters, rather than all getting a view.
      const view = win ? null : this.cam.visibleRect();
      for (const id of this.pendingAdded) {
        const el = store.get(id);
        if (!el || this.views.has(id)) continue;
        if (definitionOf(el.kind).textured) this.allocSlot(id);
        if (this.forceMount(id) || (win && this.inWindow(el, win))) {
          this.mount(el);
          changed = true;
        } else if (view) {
          this.enqueueMount(el, (view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2);
        }
      }
      this.pendingAdded.clear();
      this.lodDirty = true;
      this.l0Missing = Math.max(this.l0Missing, 1);
    }
    if (this.pendingUpdated.size > 0) {
      for (const [id, props] of this.pendingUpdated) {
        const el = store.get(id);
        if (!el) continue;
        const view = this.views.get(id);
        if (!view) {
          if (win && this.inWindow(el, win)) {
            this.mount(el);
            changed = true;
          } else {
            // Not mounted, but its slot may hold a card (and textures) of the old media.
            this.syncSlot(id, el);
          }
          continue;
        }
        if (props.has('kind') || definitionOf(el.kind).variant !== view.variant) {
          this.unmountId(id);
          if (definitionOf(el.kind).textured) this.allocSlot(id);
          else this.freeSlot(id);
          this.mount(el);
        } else {
          view.update(el, [...props], this.rectOf(el), this.ctx);
          if (view instanceof MediaView) this.syncCard(view, el);
          this.applyOverrides(id, view);
        }
        changed = true;
      }
      this.pendingUpdated.clear();
      this.lodDirty = true;
    }
    if (store.orderVersion !== this.orderSeen) {
      this.orderSeen = store.orderVersion;
      for (const [id, v] of this.views) v.display.zIndex = store.rank(id);
      changed = true;
    }
    return changed;
  }

  // The store was replaced wholesale (first load, `load()`): reconcile the views, slots and textures with
  // it. Textures of cards that are still there stay resident.
  private reloadAll(): void {
    const store = this.store;
    if (!store) return;
    const first = this.views.size === 0 && this.slotOf.size === 0;
    for (const [id, view] of [...this.views]) {
      const el = store.get(id);
      if (!el || el.kind !== view.kind) this.unmountId(id);
    }
    for (const id of [...this.slotOf.keys()]) {
      const el = store.get(id);
      if (!el || !definitionOf(el.kind).textured) this.freeSlot(id);
    }
    for (const el of store.elements()) if (definitionOf(el.kind).textured) this.allocSlot(el.id);
    const all = ['x', 'y', 'w', 'h', 'rot', 'locked', 'media', 'radius'];
    for (const [id, view] of [...this.views]) {
      const el = store.get(id) as Element;
      view.update(el, all, this.rectOf(el), this.ctx);
      if (view instanceof MediaView) this.syncCard(view, el);
    }
    // Slots without a view keep their cards across a reload too: the new store may hold other media.
    for (const [id, slot] of this.slotOf) {
      if (!this.slotView[slot]) this.syncSlot(id, store.get(id) as Element);
    }
    if (first) {
      this.t0 = performance.now();
      this.firstPaintMs = null;
      this.l1CompleteMs = null;
    }
    this.l0Missing = Math.max(this.slotOf.size, this.l0Missing);
    this.mountedWin = null;
    this.orderSeen = -1;
    this.dirty = true;
    this.lodDirty = true;
    this.requestFrame();
  }

  private clearViews(): void {
    this.mountQueue.length = 0;
    this.queued.clear();
    for (const id of [...this.views.keys()]) this.unmountId(id);
    this.views.clear();
    this.mediaViews.clear();
  }

  // ── Cards: slots and media ─────────────────────────────────────────────────
  private allocSlot(id: ElementId): number {
    let s = this.slotOf.get(id);
    if (s !== undefined) return s;
    s = this.freeSlots.pop() ?? this.slotCount++;
    this.slotOf.set(id, s);
    if (s >= this.slotLevel.length) this.growSlots(s + 1);
    this.slotLevel[s] = -1;
    this.slotOnScreen[s] = 0;
    this.slotOwn[s] = 0;
    this.slotBaked[s] = 0;
    this.slotBakedAspect[s] = 0;
    this.slotCard[s] = null;
    this.slotView[s] = null;
    return s;
  }

  private growSlots(min: number): void {
    let n = this.slotLevel.length;
    while (n < min) n *= 2;
    const lv = new Int8Array(n);
    lv.set(this.slotLevel);
    const on = new Uint8Array(n);
    on.set(this.slotOnScreen);
    const own = new Uint8Array(n);
    own.set(this.slotOwn);
    const baked = new Float32Array(n);
    baked.set(this.slotBaked);
    const bakedAspect = new Float32Array(n);
    bakedAspect.set(this.slotBakedAspect);
    this.slotLevel = lv;
    this.slotOnScreen = on;
    this.slotOwn = own;
    this.slotBaked = baked;
    this.slotBakedAspect = bakedAspect;
  }

  private freeSlot(id: ElementId): void {
    const s = this.slotOf.get(id);
    if (s === undefined) return;
    this.slotOf.delete(id);
    this.slotCard[s] = null;
    this.slotView[s] = null;
    this.tm.forget(s);
    this.freeSlots.push(s);
  }

  private hashOf(h: Uint8Array | string | undefined): Uint8Array | undefined {
    if (h === undefined) return undefined;
    if (typeof h !== 'string') return h;
    let b = this.hashCache.get(h);
    if (!b) {
      try {
        b = decodeBase64(h);
      } catch {
        return undefined;
      }
      this.hashCache.set(h, b);
    }
    return b;
  }

  private fillCard(card: BoardCard, el: Element): void {
    const m = el.media;
    card.w = el.w;
    card.h = el.h;
    card.thumbhash = this.hashOf(m.thumbhash);
    // A missing rendition falls back to the picture itself: the decode worker downsamples it.
    card.l1Url = m.sizes?.small ?? m.src;
    card.l2Url = m.sizes?.medium ?? m.src;
    card.l3Url = m.sizes?.large ?? m.src;
    card.radius = el.radius;
  }

  private newCard(slot: number, el: Element): BoardCard {
    const card: BoardCard = {
      id: slot,
      w: el.w,
      h: el.h,
      thumbhash: undefined,
      l1Url: undefined,
      l2Url: undefined,
      l3Url: undefined,
      radius: DEFAULTS.cardRadius,
    };
    this.fillCard(card, el);
    this.slotBaked[slot] = Math.max(el.w, el.h);
    this.slotBakedAspect[slot] = el.w > 0 ? el.h / el.w : 0;
    return card;
  }

  private mountMedia(view: MediaView, el: Element): void {
    const slot = this.allocSlot(el.id);
    let card = this.slotCard[slot];
    if (!card) {
      card = this.newCard(slot, el);
      this.slotCard[slot] = card;
    } else this.refreshCard(card, el);
    view.card = card;
    this.slotView[slot] = view;
    this.mediaViews.add(view);
  }

  // Brings a slot's BoardCard up to date with its element and returns whether what is resident for it went
  // stale (and was forgotten). A rendition URL or ThumbHash that CHANGED (not just appeared) means another
  // picture; a different corner radius, or a long side so far from the size the textures were baked at that
  // the corners drawn are off by more than BAKE_CORNER_SLACK, means the baked rounded corners no longer fit;
  // and a height / width ratio that moved by more than BAKE_ASPECT_SLACK means the textures were cropped
  // (cover) to another shape.
  // Only committed store changes get here: a live drag / resize preview never touches the card.
  private refreshCard(card: BoardCard, el: Element): boolean {
    const m = el.media;
    const l1 = m.sizes?.small ?? m.src;
    const l2 = m.sizes?.medium ?? m.src;
    const l3 = m.sizes?.large ?? m.src;
    const long = Math.max(el.w, el.h);
    const baked = this.slotBaked[card.id];
    const aspect = el.w > 0 ? el.h / el.w : 0;
    const bakedAspect = this.slotBakedAspect[card.id];
    const stale =
      (card.l1Url !== undefined && card.l1Url !== l1) ||
      (card.l2Url !== undefined && card.l2Url !== l2) ||
      (card.l3Url !== undefined && card.l3Url !== l3) ||
      (card.thumbhash !== undefined && !sameBytes(card.thumbhash, this.hashOf(m.thumbhash))) ||
      card.radius !== el.radius ||
      (baked > 0 && (el.radius * Math.abs(long - baked)) / baked > BAKE_CORNER_SLACK) ||
      (bakedAspect > 0 && Math.abs(aspect - bakedAspect) / bakedAspect > BAKE_ASPECT_SLACK);
    this.fillCard(card, el);
    if (stale) {
      this.tm.forget(card.id);
      this.slotLevel[card.id] = -1;
      this.slotBaked[card.id] = long;
      this.slotBakedAspect[card.id] = aspect;
      this.l0Missing++;
    }
    return stale;
  }

  // The element's size or media changed: keep the BoardCard current, and show the placeholder again when
  // what was resident went stale.
  private syncCard(view: MediaView, el: Element): void {
    const card = view.card;
    if (card && this.refreshCard(card, el)) view.setTexture(null, -1, this.ctx);
  }

  // The same for a slot that has no view (the element is off screen): its card, and the textures its ThumbHash
  // and thumbnails already got, must not outlive a change of media.
  private syncSlot(id: ElementId, el: Element): void {
    const slot = this.slotOf.get(id);
    const card = slot === undefined ? null : this.slotCard[slot];
    if (card) this.refreshCard(card, el);
  }

  // ── Views ──────────────────────────────────────────────────────────────────
  // The committed world rect of an element (or its live preview).
  private rectOf(el: Element): WorldRect {
    return this.previews.get(el.id) ?? worldRectOf(el);
  }

  private forceMount(id: ElementId): boolean {
    return this.pinned.has(id) || this.previews.has(id);
  }

  private inWindow(el: Element, win: Rect): boolean {
    const b = elementBox(el);
    return b.minX <= win.x1 && b.maxX >= win.x0 && b.minY <= win.y1 && b.maxY >= win.y0;
  }

  // Puts an element in the mount queue, ordered by its distance from the view centre (cx, cy).
  private enqueueMount(el: Element, cx: number, cy: number): void {
    if (this.queued.has(el.id)) return;
    const b = elementBox(el);
    const d = Math.hypot((b.minX + b.maxX) / 2 - cx, (b.minY + b.maxY) / 2 - cy);
    this.mountQueue.push({ id: el.id, key: d });
    this.queued.add(el.id);
    this.queueSorted = false;
  }

  // Creates the views of queued elements until the tick's budget is spent. Anything that left the window
  // meanwhile (a fast pan) is dropped without ever being built.
  private drainMounts(): void {
    const q = this.mountQueue;
    const store = this.store;
    if (q.length === 0 || !store) return;
    if (!this.queueSorted) {
      // Descending, so pop() hands out the nearest first.
      q.sort((a, b) => b.key - a.key);
      this.queueSorted = true;
    }
    const t0 = performance.now();
    const win = this.mountedWin;
    let n = 0;
    while (q.length > 0) {
      const it = q.pop() as { id: ElementId; key: number };
      this.queued.delete(it.id);
      const el = store.get(it.id);
      if (!el || this.views.has(it.id)) continue;
      if (win && !this.forceMount(it.id) && !this.inWindow(el, win)) continue;
      this.mount(el);
      n++;
      if (performance.now() - t0 >= MOUNT_BUDGET_MS) break;
    }
    if (n > 0) {
      this.dirty = true;
      this.lodDirty = true;
    }
  }

  private mount(el: Element): void {
    const store = this.store as StageStore;
    const view = this.pools.acquire(el.kind);
    view.mark = this.stamp;
    this.ctx.scale = this.cam.scale;
    if (view instanceof MediaView) this.mountMedia(view, el);
    view.mount(el, this.rectOf(el), this.ctx);
    view.display.zIndex = store.rank(el.id);
    this.views.set(el.id, view);
    if (view instanceof MediaView) this.paintMedia(view);
    this.applyOverrides(el.id, view);
    this.world.addChild(view.display);
    this.counters.mounts++;
  }

  private unmountId(id: ElementId): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    this.world.removeChild(view.display);
    view.setAlphaOverride(1);
    view.display.visible = true;
    if (view instanceof MediaView) {
      const s = view.card?.id;
      if (s !== undefined) {
        this.slotOnScreen[s] = 0;
        this.slotOwn[s] = 0;
        this.slotView[s] = null;
      }
      this.mediaViews.delete(view);
    }
    view.unmount();
    this.pools.release(view);
    this.counters.unmounts++;
  }

  private applyOverrides(id: ElementId, view: ElementView): void {
    view.setAlphaOverride(this.alphas.get(id) ?? 1);
    view.display.visible = !this.hidden.has(id);
    const p = this.previews.get(id);
    if (p) view.setRect(p);
  }

  // ── Overrides (set by the interaction layer) ───────────────────────────────
  // A drag / resize preview: the element is drawn at this rect (world space) without touching the
  // store. Call every pointer move; cheap for a few hundred elements.
  setPreview(id: ElementId, x: number, y: number, w: number, h: number, rot: number): void {
    // A fresh rect on every call, never the previous one rewritten: a view keeps the rect it was last given.
    const p: PreviewRect = { x, y, w, h, rot };
    const fresh = !this.previews.has(id);
    this.previews.set(id, p);
    if (fresh) {
      const el = this.store?.get(id);
      if (el && !this.views.has(id)) this.mount(el);
    }
    const v = this.views.get(id);
    if (v) v.setRect(p);
    this.dirty = true;
    this.requestFrame();
  }

  clearPreview(id: ElementId): void {
    const p = this.previews.get(id);
    if (!p) return;
    this.previews.delete(id);
    const el = this.store?.get(id);
    const v = this.views.get(id);
    if (el && v) {
      v.update(el, ['x', 'y', 'w', 'h', 'rot'], this.rectOf(el), this.ctx);
      if (v instanceof MediaView) this.syncCard(v, el);
    }
    this.dirty = true;
    this.requestFrame();
  }

  clearPreviews(): void {
    for (const id of [...this.previews.keys()]) this.clearPreview(id);
  }

  previewRectOf(id: ElementId): PreviewRect | undefined {
    return this.previews.get(id);
  }

  get previewCount(): number {
    return this.previews.size;
  }

  // Hides the canvas copy of an element.
  setHidden(id: ElementId, hidden: boolean): void {
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    const v = this.views.get(id);
    if (v) v.display.visible = !hidden;
    this.dirty = true;
    this.requestFrame();
  }

  setAlpha(id: ElementId, alpha: number | null): void {
    if (alpha === null || alpha >= 1) this.alphas.delete(id);
    else this.alphas.set(id, alpha);
    const v = this.views.get(id);
    if (v) v.setAlphaOverride(alpha ?? 1);
    this.dirty = true;
    this.requestFrame();
  }

  // Keeps an element mounted whatever the window says.
  pin(id: ElementId, pinned: boolean): void {
    if (pinned) {
      this.pinned.add(id);
      const el = this.store?.get(id);
      if (el && !this.views.has(id)) this.mount(el);
    } else this.pinned.delete(id);
  }

  // The view of a mounted element (animations, tests); null when not mounted.
  viewOf(id: ElementId): ElementView | null {
    return this.views.get(id) ?? null;
  }

  isMounted(id: ElementId): boolean {
    return this.views.has(id);
  }

  // ── Camera and coordinates ─────────────────────────────────────────────────
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const c = this.cam.cam;
    return { x: (sx - c.tx) / c.scale, y: (sy - c.ty) / c.scale };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const c = this.cam.cam;
    return { x: c.tx + wx * c.scale, y: c.ty + wy * c.scale };
  }

  // Page (client) coordinates -> host-local screen coordinates.
  clientToLocal(cx: number, cy: number): { x: number; y: number } {
    const r = this.hostEl.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  }

  get dprValue(): number {
    return this.dpr;
  }

  contentBounds(ids?: Iterable<ElementId>): Rect {
    const store = this.store;
    let b = emptyBox();
    let any = false;
    if (store) {
      const list: Iterable<Element | undefined> = ids
        ? (function* () {
            for (const id of ids) yield store.get(id);
          })()
        : store.elements();
      for (const el of list) {
        if (!el) continue;
        const eb = elementBox(el);
        b = {
          minX: Math.min(b.minX, eb.minX),
          minY: Math.min(b.minY, eb.minY),
          maxX: Math.max(b.maxX, eb.maxX),
          maxY: Math.max(b.maxY, eb.maxY),
        };
        any = true;
      }
    }
    if (any) return { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY };
    // Nothing resolved: a unit rect at the origin (the public shape), remembered as "no content" so a fit
    // of it does nothing.
    const none = { x0: 0, y0: 0, x1: 1, y1: 1 };
    noContent.add(none);
    return none;
  }

  fit(animate = true, pad = 48): void {
    this.cam.requestFit(this.fitTarget(() => this.contentBounds()), pad, animate);
  }

  // `r` may be a function: it is read when the fit is applied (a fit asked for on a host that has no size
  // yet waits for the first real size).
  fitRect(r: Rect | (() => Rect), animate = true, pad = 48): void {
    this.cam.requestFit(this.fitTarget(r), pad, animate, 440);
  }

  // What a fit reads: the rect, or null for the "no content" rect of `contentBounds` (an empty board, ids
  // that match no card), which leaves the camera alone.
  private fitTarget(r: Rect | (() => Rect)): () => Rect | null {
    return () => {
      const rect = typeof r === 'function' ? r() : r;
      return noContent.has(rect) ? null : rect;
    };
  }

  zoomToActual(): void {
    this.cam.zoomToActual();
  }

  setCamera(c: Camera): void {
    this.cam.jumpTo(c);
  }

  zoomBy(k: number): void {
    const cam = this.cam.cam;
    const cx = this.cam.width / 2;
    const cy = this.cam.height / 2;
    const s = Math.min(this.cam.maxScale, Math.max(this.cam.minScale, cam.scale * k));
    const z = {
      scale: s,
      tx: cx - (cx - cam.tx) * (s / cam.scale),
      ty: cy - (cy - cam.ty) * (s / cam.scale),
    };
    this.cam.flyTo(z, 220);
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  setTheme(theme: Theme): void {
    const borderChanged =
      theme.border !== this.theme.border || theme.borderAlpha !== this.theme.borderAlpha;
    this.theme = theme;
    this.ctx.theme = theme;
    this.applyThemeToScene();
    // The dots' opacity is the theme's (derived with the camera), not only the tint.
    this.applyCamera();
    this.overlay.setTheme(theme);
    for (const v of this.views.values()) v.refresh(this.ctx);
    if (borderChanged) {
      // The hairline is baked into every texture: rebuild them.
      this.tm.setBorder(this.borderCss());
      this.dropAllTextures();
    }
    this.dirty = true;
    this.requestFrame();
  }

  setGrid(on: boolean): void {
    this.showGrid = on;
    this.applyCamera();
    this.dirty = true;
    this.requestFrame();
  }

  private borderCss(): string {
    const t = this.theme;
    const r = (t.border >> 16) & 255;
    const g = (t.border >> 8) & 255;
    const b = t.border & 255;
    return `rgba(${r},${g},${b},${t.borderAlpha})`;
  }

  private applyThemeToScene(): void {
    this.app.renderer.background.color = this.theme.canvas;
    this.bg.tint = this.theme.dot;
  }

  // ── Loop ───────────────────────────────────────────────────────────────────
  requestFrame(): void {
    if (this.raf || this.disposed) return;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = 0;
    }
    this.counters.rafCalls++;
    this.raf = requestAnimationFrame(this.tick);
  }

  // Runs at the start of every tick (the input controller flushes coalesced pointer moves here, so a
  // drag preview and its render share one frame).
  onBeforeFrame(hook: () => void): () => void {
    this.beforeHooks.push(hook);
    return () => {
      this.beforeHooks = this.beforeHooks.filter((h) => h !== hook);
    };
  }

  // Forces Pixi to rebuild the world's batches at the next render (see retire.ts): a batch keeps listing
  // a texture its sprites stopped using, and we are about to destroy it.
  private rebuildBatches(): void {
    const rg = (this.world as unknown as { renderGroup?: { structureDidChange: boolean } })
      .renderGroup;
    if (rg) rg.structureDidChange = true;
    this.dirty = true;
  }

  // DOM overlays (the video layer) sync from here, in the same rAF as the render.
  onFrame(hook: (camChanged: boolean) => void): () => void {
    this.frameHooks.push(hook);
    return () => {
      this.frameHooks = this.frameHooks.filter((h) => h !== hook);
    };
  }

  // Runs once the camera has been still for SETTLE_MS (the exact pass is done).
  onSettle(hook: () => void): () => void {
    this.settleHooks.push(hook);
    return () => {
      this.settleHooks = this.settleHooks.filter((h) => h !== hook);
    };
  }

  markDirty(): void {
    this.dirty = true;
    this.requestFrame();
  }

  private tick = (ts: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    const t0 = performance.now();
    this.counters.ticks++;
    const dt = this.lastTs ? Math.min(50, ts - this.lastTs) : 16.7;
    this.lastTs = ts;
    for (const h of this.beforeHooks) this.runHook(h);
    const camBusy = this.cam.step(dt);
    let dirty = this.dirty;
    this.dirty = false;
    let camChanged = false;
    this.ctx.scale = this.cam.scale;

    const ph = this.phase;
    ph.store = ph.camera = ph.upload = ph.overlay = ph.render = 0;
    let tp = performance.now();
    const lap = (k: 'store' | 'camera' | 'upload' | 'overlay' | 'render'): void => {
      const n = performance.now();
      ph[k] = n - tp;
      tp = n;
    };
    try {
      this.where = 'store';
      if (this.flushStore()) dirty = true;
      lap('store');
      this.where = 'camera';
      if (this.cam.version !== this.renderedVersion) {
        this.renderedVersion = this.cam.version;
        this.applyCamera();
        dirty = true;
        camChanged = true;
        // No window yet (first tick, a resize): the mount queue needs one before it drains.
        if (t0 - this.lastLod >= LOD_INTERVAL_MS || this.mountedWin === null) {
          this.cullAndLod(t0, false);
        }
      } else if (this.lodDirty) {
        this.cullAndLod(t0, false);
      }
      this.drainMounts();
      // View-level changes made by the LOD pass (placeholder repaints) need a render too.
      if (this.dirty) {
        dirty = true;
        this.dirty = false;
      }
      lap('camera');
      this.where = 'upload';
      if (!this.lost) {
        const changed = this.tm.frame(this.opts.uploadBudgetMs, t0);
        if (changed.length > 0) {
          for (const slot of changed) this.applySlot(slot);
          dirty = true;
        }
        if (this.repointEvicted()) dirty = true;
      }
      lap('upload');
      this.where = 'overlay';
      if (this.overlay.draw(this.cam.cam)) dirty = true;
      lap('overlay');
      this.where = 'hooks';
      // A hook is host / layer code: a throw there says nothing about the textures, so it is reported on
      // its own and never reaches `recoverTextures`.
      for (const h of this.frameHooks) this.runHook(h, camChanged);
      this.where = 'render';
      if (dirty && !this.lost) {
        this.render();
        lap('render');
        this.tm.afterRender();
        this.rendersSinceRetire++;
      }
      this.where = 'idle';
    } catch (e) {
      this.recoverTextures(e);
    }
    this.trackProgress(t0);

    const ms = performance.now() - t0;
    this.tickMs[this.nTick++ & 4095] = ms;
    if (ms > 25) {
      // The slowest frames, with where the time went (read through stats().slowTicks).
      this.slowTicks.push({
        ms: r2(ms),
        scale: r2(this.cam.scale),
        mounted: this.views.size,
        mounts: this.counters.mounts,
        ...Object.fromEntries(Object.entries(ph).map(([k, v]) => [k, r2(v)])),
      });
      if (this.slowTicks.length > 40) this.slowTicks.shift();
    }

    if (camBusy || this.uploadsPending() || this.lodDirty || this.dirty || this.mountQueue.length > 0) {
      this.requestFrame();
    } else {
      // Parked: no rAF until the next input or decode. One timer runs the exact cull + LOD pass
      // once the camera has been still for SETTLE_MS.
      this.lastTs = 0;
      this.settleTimer = window.setTimeout(this.settle, SETTLE_MS);
    }
  };

  private settle = (): void => {
    this.settleTimer = 0;
    if (this.disposed) return;
    this.cullAndLod(performance.now(), true);
    // Everything retired has been through at least one render by now.
    this.tm.flushRetired();
    for (const h of this.settleHooks) this.runHook(h);
    if (this.dirty || this.uploadsPending() || this.mountQueue.length > 0) {
      this.requestFrame();
    }
  };

  // Decoded bitmaps wait for the upload step. While the GL context is lost that step is skipped, so they
  // cannot keep the loop spinning: the restore (`dropAllTextures`) starts it again.
  private uploadsPending(): boolean {
    return this.tm.pendingWork && !this.lost;
  }

  // Runs a hook so that one that throws neither stops the others nor the loop. Reported once per hook
  // (console), counted every time (`hookErrors` in the stats).
  private runHook(hook: (arg: boolean) => void, arg = false): void {
    try {
      hook(arg);
    } catch (e) {
      this.counters.hookErrors++;
      if (this.reportedHooks.has(hook)) return;
      this.reportedHooks.add(hook);
      console.error('[corkboard] a hook threw (reported once per hook):', e);
    }
  }

  private render(): void {
    const t = performance.now();
    this.gpu?.begin();
    this.app.render();
    this.gpu?.end();
    this.renderMs[this.nRender++ & 4095] = performance.now() - t;
    this.counters.renders++;
    if (this.gpu) {
      for (const ms of this.gpu.poll()) this.gpuMs[this.nGpu++ & 4095] = ms;
    }
  }

  private applyCamera(): void {
    const { tx, ty, scale } = this.cam.cam;
    this.world.position.set(tx, ty);
    this.world.scale.set(scale);
    // Background dots: a screen-space tiling sprite following the camera; hidden below 25 % zoom.
    const a = Math.max(0, Math.min(1, (scale - 0.25) / 0.15));
    this.bg.visible = this.showGrid && a > 0;
    if (this.bg.visible) {
      this.bg.alpha = a * (this.theme.dotAlpha ?? 0.0805);
      const k = (scale * GRID) / 64;
      this.bg.tileScale.set(k);
      this.bg.tilePosition.set(tx - (GRID / 2) * scale, ty - (GRID / 2) * scale);
    }
  }

  // ── Culling + LOD ──────────────────────────────────────────────────────────
  private cullAndLod(now: number, settled: boolean): void {
    this.lodDirty = false;
    if (!this.store || this.cam.width === 0) return;
    this.lastLod = now;
    this.counters.cullPasses++;
    const view = this.cam.visibleRect();
    const scale = this.cam.scale;
    const covered =
      this.mountedWin !== null &&
      view.x0 >= this.mountedWin.x0 &&
      view.y0 >= this.mountedWin.y0 &&
      view.x1 <= this.mountedWin.x1 &&
      view.y1 <= this.mountedWin.y1 &&
      scale / this.mountedScale < 1.5 &&
      scale / this.mountedScale > 1 / 1.5;
    if (!covered || settled) this.requery(view, scale);
    this.lodPass(now, view, scale);
    this.lodPassMs[this.nLodPass++ & 1023] = performance.now() - now;
  }

  private requery(view: Rect, scale: number): void {
    const store = this.store as StageStore;
    this.counters.requeries++;
    const padX = (view.x1 - view.x0) * this.opts.overscan;
    const padY = (view.y1 - view.y0) * this.opts.overscan;
    const win: Rect = {
      x0: view.x0 - padX,
      y0: view.y0 - padY,
      x1: view.x1 + padX,
      y1: view.y1 + padY,
    };
    const tS = performance.now();
    const hits = store.searchInto(
      { minX: win.x0, minY: win.y0, maxX: win.x1, maxY: win.y1 },
      this.hits,
    );
    this.reqMs.search += performance.now() - tS;
    const tM = performance.now();
    const stamp = ++this.stamp;
    let entered = 0;
    let left = 0;
    let already = 0;
    const cx = (view.x0 + view.x1) / 2;
    const cy = (view.y0 + view.y1) / 2;
    for (let i = 0; i < hits.length; i++) {
      const el = hits[i];
      const v = this.views.get(el.id);
      if (v) {
        v.mark = stamp;
        already++;
      } else if (!this.queued.has(el.id)) {
        this.enqueueMount(el, cx, cy);
        entered++;
      }
    }
    this.reqMs.mount += performance.now() - tM;
    const tU = performance.now();
    // More mounted than hit means some are stale (and the pinned / previewed ones stay).
    if (this.views.size !== already) {
      for (const [id, v] of this.views) {
        if (v.mark !== stamp && !this.forceMount(id)) {
          this.unmountId(id);
          left++;
        }
      }
    }
    this.reqMs.unmount += performance.now() - tU;
    this.hits.length = 0;
    this.mountedWin = win;
    this.mountedScale = scale;
    if (entered > 0 || left > 0) this.dirty = true;
  }

  // Points a card's sprite at the best resident texture for its wanted level.
  private paintMedia(view: MediaView): boolean {
    const card = view.card;
    if (!card) return false;
    const want = Math.max(0, this.slotLevel[card.id]) as Level;
    const b = this.tm.best(card, want);
    return view.setTexture(b ? b.tex : null, b ? b.level : -1, this.ctx);
  }

  private applySlot(slot: number): boolean {
    const v = this.slotView[slot];
    return v ? this.paintMedia(v) : false;
  }

  private lodPass(now: number, view: Rect, scale: number): void {
    this.counters.lodPasses++;
    this.ctx.scale = scale;
    const k = scale * this.dpr;
    const cx = (view.x0 + view.x1) / 2;
    const cy = (view.y0 + view.y1) / 2;
    const wanted: WantedItem[] = [];
    const tm = this.tm;
    let l0Missing = 0;
    let changed = false;
    // Texture memory follows what is ON SCREEN, not what is mounted: the overscan ring exists so a pan
    // finds sprites already there (with a thumbnail), but only cards touching the viewport (plus a
    // small margin) get an own texture and are protected from eviction.
    const mx = (view.x1 - view.x0) * VIEW_MARGIN;
    const my = (view.y1 - view.y0) * VIEW_MARGIN;
    const l3: { slot: number; dist: number; d: number }[] = [];
    const room = tm.hasHeadroom();
    for (const v of this.mediaViews) {
      const card = v.card;
      const el = v.el;
      if (!card || !el) continue;
      const slot = card.id;
      const d = Math.max(el.w, el.h) * k;
      const prev = this.slotLevel[slot];
      let lvl = pickLevel(d, prev < 0 ? null : (prev as Level));
      // With no ThumbHash there is no L0 to show: the small rendition is the first level.
      if (lvl === 0 && !card.thumbhash) lvl = 1;
      const r = this.rectOf(el);
      const onScreen =
        r.x < view.x1 + mx &&
        r.x + r.w > view.x0 - mx &&
        r.y < view.y1 + my &&
        r.y + r.h > view.y0 - my;
      const dist = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy) * scale;
      if (lvl === 3) {
        if (onScreen) l3.push({ slot, dist, d });
        lvl = 2;
      }
      this.slotLevel[slot] = lvl;
      this.slotOnScreen[slot] = onScreen ? 1 : 0;
      this.slotOwn[slot] = onScreen && lvl >= 2 ? lvl : 0;
      if (onScreen) tm.touch(card, now, lvl >= 2);
      if (card.thumbhash && !tm.has(card, 0)) {
        wanted.push({ card, level: 0, dist });
        l0Missing++;
      }
      // L1 is also the stopgap while an L2 is on its way. A card off screen only gets one while there is
      // room: past the budget the eviction pass would drop it again and the loop would never park.
      if (lvl >= 1 && !tm.has(card, 1) && (onScreen || room)) wanted.push({ card, level: 1, dist });
      if (lvl === 2 && onScreen) wanted.push({ card, level: 2, dist, bucket: l2Bucket(d) });
    }
    // At most MAX_L3 cards (the nearest to the view centre) get the large rendition.
    if (l3.length > 0) {
      l3.sort((a, b) => a.dist - b.dist);
      for (let i = 0; i < l3.length; i++) {
        const { slot, dist, d } = l3[i];
        const card = this.slotCard[slot] as BoardCard;
        if (i < MAX_L3) {
          this.slotLevel[slot] = 3;
          this.slotOwn[slot] = 3;
          // L2 stays the stopgap until the large texture lands.
          if (!tm.has(card, 2)) wanted.push({ card, level: 2, dist, bucket: l2Bucket(480) });
          wanted.push({ card, level: 3, dist, bucket: l3Bucket(d) });
        } else {
          wanted.push({ card, level: 2, dist, bucket: l2Bucket(d) });
        }
      }
    }
    // ThumbHash cells for everything else, so a pan finds a placeholder already there.
    const store = this.store as StageStore;
    if (this.l0Missing > 0) {
      let missing = 0;
      for (const [id, slot] of this.slotOf) {
        let card = this.slotCard[slot];
        if (!card) {
          // Never mounted: build its BoardCard now so the thumbhash can be requested.
          const el = store.get(id);
          if (!el) continue;
          card = this.newCard(slot, el);
          this.slotCard[slot] = card;
        }
        if (this.slotView[slot] || tm.has(card, 0)) continue;
        if (!card.thumbhash) continue;
        missing++;
        const el = store.get(id) as Element;
        const r = this.rectOf(el);
        const dist = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy) * scale;
        wanted.push({ card, level: 0, dist: dist + FAR_DIST });
      }
      this.l0Missing = missing + l0Missing;
    } else this.l0Missing = l0Missing;
    tm.setWanted(wanted, now);
    // Pins moved with the camera: evict what just left the screen if the budget asks for it.
    tm.enforceBudget(now);
    for (const v of this.mediaViews) if (this.paintMedia(v)) changed = true;
    if (this.repointEvicted() || changed) this.dirty = true;
  }

  // An evicted texture is destroyed after later renders: any sprite still showing it must fall back to
  // what is left (a lower level, else the placeholder) before the next render.
  private repointEvicted(): boolean {
    let any = false;
    for (const slot of this.tm.takeEvicted()) if (this.applySlot(slot)) any = true;
    return any;
  }

  private trackProgress(now: number): void {
    if (this.firstPaintMs !== null && this.l1CompleteMs !== null) return;
    if (this.mediaViews.size === 0 || this.mountQueue.length > 0) return;
    let all0 = true;
    let all1 = true;
    for (const v of this.mediaViews) {
      const card = v.card;
      if (!card) continue;
      const has = (l: Level): boolean => this.tm.has(card, l);
      if (!has(0) && !has(1) && !has(2) && !has(3)) all0 = false;
      if (!has(1) && !has(2) && !has(3)) all1 = false;
      if (!all0) break;
    }
    if (all0 && this.firstPaintMs === null) this.firstPaintMs = now - this.t0;
    if (all1 && this.l1CompleteMs === null) this.l1CompleteMs = now - this.t0;
  }

  // ── Context loss ───────────────────────────────────────────────────────────
  private loseExt: WEBGL_lose_context | null = null;
  private bindContextLoss(): void {
    const c = this.canvas;
    const onLost = (e: Event): void => {
      e.preventDefault();
      this.lost = true;
    };
    const onRestored = (): void => {
      // Pixi has re-initialised its GL state; every texture of ours is gone.
      this.lost = false;
      this.dropAllTextures();
    };
    c.addEventListener('webglcontextlost', onLost);
    c.addEventListener('webglcontextrestored', onRestored);
    this.cleanups.push(() => {
      c.removeEventListener('webglcontextlost', onLost);
      c.removeEventListener('webglcontextrestored', onRestored);
    });
  }

  // Forgets every texture and reloads what is on screen, in viewport order (context restore, theme
  // change, and the recovery path below).
  private dropAllTextures(): void {
    this.tm.reset();
    for (const v of this.mediaViews) v.setTexture(null, -1, this.ctx);
    this.slotLevel.fill(-1);
    this.l0Missing = Math.max(this.slotOf.size, 1);
    this.dirty = true;
    this.mountedWin = null;
    this.cullAndLod(performance.now(), true);
    this.requestFrame();
  }

  // A render or an upload threw: in practice a texture destroyed while a Pixi batch still held it (the
  // RetireQueue's two-render delay is the structural fix; this guard stays as the safety net). Count it,
  // log it, and rebuild the textures so the board heals instead of throwing on every frame.
  private recoverTextures(e: unknown): void {
    this.counters.renderErrors++;
    this.renderErrorsTotal++;
    const detail =
      e instanceof Error
        ? `${e.message} | ${(e.stack ?? '').split('\n').slice(1, 10).join(' | ')}`
        : String(e);
    console.error(`[corkboard] frame failed in ${this.where}, rebuilding textures: ${detail}`);
    try {
      this.dropAllTextures();
    } catch (e2) {
      console.error('[corkboard] recovery failed', e2);
    }
  }

  // Test hooks (WEBGL_lose_context).
  loseContext(): void {
    const gl = this.renderer.gl as WebGL2RenderingContext;
    this.loseExt = gl.getExtension('WEBGL_lose_context');
    this.loseExt?.loseContext();
  }
  restoreContext(): void {
    this.loseExt?.restoreContext();
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  resetStats(): void {
    this.nTick = 0;
    this.nRender = 0;
    this.nGpu = 0;
    this.counters = {
      renderErrors: 0,
      hookErrors: 0,
      rafCalls: 0,
      ticks: 0,
      renders: 0,
      cullPasses: 0,
      requeries: 0,
      lodPasses: 0,
      mounts: 0,
      unmounts: 0,
    };
    this.slowTicks = [];
    this.reqMs = { search: 0, mount: 0, unmount: 0, lod: 0 };
    this.nLodPass = 0;
    const s = this.tm.stats;
    s.uploadMsMax = 0;
    s.overBudgetMsMax = 0;
    s.peakBytes = this.tm.totalBytes;
  }

  // Counters and timings of the render loop: rAF callbacks, ticks, renders, mounted views, texture
  // memory by level, decode / upload numbers, tick / render / GPU percentiles.
  stats(): Record<string, unknown> {
    const levels = [0, 0, 0, 0];
    for (const v of this.mediaViews) {
      const s = v.card?.id;
      if (s !== undefined && this.slotLevel[s] >= 0) levels[this.slotLevel[s]]++;
    }
    const nt = Math.min(this.nTick, 4096);
    const nr = Math.min(this.nRender, 4096);
    const ng = Math.min(this.nGpu, 4096);
    const s = this.tm.stats;
    const pages = this.tm.pageCount();
    return {
      cards: this.slotOf.size,
      mounted: this.views.size,
      mountQueue: this.mountQueue.length,
      slowTicks: this.slowTicks,
      requeryMs: Object.fromEntries(Object.entries(this.reqMs).map(([k, v]) => [k, r2(v)])),
      lodPassMs: {
        n: Math.min(this.nLodPass, 1024),
        p50: r2(pct(this.lodPassMs, Math.min(this.nLodPass, 1024), 0.5)),
        p95: r2(pct(this.lodPassMs, Math.min(this.nLodPass, 1024), 0.95)),
        max: r2(Math.max(0, ...this.lodPassMs.subarray(0, Math.min(this.nLodPass, 1024)))),
      },
      worldChildren: this.world.children.length,
      pool: this.pools.stats(),
      scale: r2(this.cam.scale),
      dpr: this.dpr,
      viewport: [this.cam.width, this.cam.height],
      levelsMounted: levels,
      textureBytes: Math.round(this.tm.totalBytes),
      textureBudget: this.opts.budgetBytes,
      textureBytesPeak: Math.round(s.peakBytes),
      overBudgetMsMax: Math.round(s.overBudgetMsMax),
      l0Pages: pages.l0,
      l1Pages: pages.l1,
      l2Textures: this.tm.l2Count(),
      l3Textures: this.tm.l3Count(),
      retiredPending: this.tm.retiredPending,
      bytes: this.tm.breakdown(),
      queued: this.tm.queued,
      inflight: this.tm.inflightCount,
      decodes: s.decodes,
      decodeMsAvg: s.decodes ? r2(s.decodeMsTotal / s.decodes) : 0,
      fetchedBytes: s.fetchedBytes,
      cancelled: s.cancelled,
      failed: s.failed,
      evictedL2: s.evictedL2,
      evictedL3: s.evictedL3,
      evictedL1: s.evictedL1,
      uploads: s.uploads,
      uploadMsMax: r2(s.uploadMsMax),
      uploadMsAvg: s.uploadFrames ? r2(s.uploadMsTotal / s.uploadFrames) : 0,
      uploadsLastFrame: s.uploadsLastFrame,
      ...this.counters,
      tickMs: {
        n: nt,
        p10: r2(pct(this.tickMs, nt, 0.1)),
        p50: r2(pct(this.tickMs, nt, 0.5)),
        p95: r2(pct(this.tickMs, nt, 0.95)),
        p99: r2(pct(this.tickMs, nt, 0.99)),
        max: r2(nt ? Math.max(...this.tickMs.subarray(0, nt)) : 0),
      },
      renderMs: {
        n: nr,
        p10: r2(pct(this.renderMs, nr, 0.1)),
        p50: r2(pct(this.renderMs, nr, 0.5)),
        p95: r2(pct(this.renderMs, nr, 0.95)),
        p99: r2(pct(this.renderMs, nr, 0.99)),
        max: r2(nr ? Math.max(...this.renderMs.subarray(0, nr)) : 0),
      },
      gpuMs: this.gpu
        ? this.gpu.supported
          ? {
              n: ng,
              p10: r2(pct(this.gpuMs, ng, 0.1)),
              p50: r2(pct(this.gpuMs, ng, 0.5)),
              p95: r2(pct(this.gpuMs, ng, 0.95)),
              max: r2(ng ? Math.max(...this.gpuMs.subarray(0, ng)) : 0),
            }
          : 'unsupported'
        : 'off',
      firstPaintMs: this.firstPaintMs === null ? null : Math.round(this.firstPaintMs),
      l1CompleteMs: this.l1CompleteMs === null ? null : Math.round(this.l1CompleteMs),
      renderErrorsTotal: this.renderErrorsTotal,
      lost: this.lost,
      glRenderer: glRendererString(this.renderer),
      theme: cssHex(this.theme.canvas),
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.unsub?.();
    for (const f of this.cleanups) f();
    this.ro.disconnect();
    this.tm.dispose();
    this.pools.dispose();
    const dots = this.bg.texture;
    this.app.destroy(true, { children: true, texture: false });
    // `texture: false` leaves the dot texture to us (it is ours alone, never shared).
    dots.destroy(true);
    this.unparkTicker();
  }

  private makeBackground(): TilingSprite {
    // 64 px texture = one 24-world-px grid cell, a soft dot in the middle (white, tinted by the theme).
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(32, 32, 3, 0, Math.PI * 2);
    g.fill();
    // Not in Pixi's global texture cache (it would keep the canvas and texture alive past the board).
    const tex = Texture.from(c, true);
    return new TilingSprite({ texture: tex, width: 1, height: 1 });
  }
}

function glRendererString(renderer: WebGLRenderer): string {
  const gl = renderer.gl as WebGL2RenderingContext;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext
    ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
}

// GPU time per render through EXT_disjoint_timer_query_webgl2 (not available everywhere).
class GpuTimer {
  supported = false;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private pending: WebGLQuery[] = [];
  private current: WebGLQuery | null = null;
  private constructor(private readonly gl: WebGL2RenderingContext) {}

  static create(renderer: WebGLRenderer): GpuTimer {
    const t = new GpuTimer(renderer.gl as WebGL2RenderingContext);
    t.ext = t.gl.getExtension('EXT_disjoint_timer_query_webgl2') as GpuTimer['ext'];
    t.supported = !!t.ext;
    return t;
  }
  begin(): void {
    if (!this.ext || this.current) return;
    this.current = this.gl.createQuery();
    if (this.current) this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.current);
  }
  end(): void {
    if (!this.ext || !this.current) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.current);
    this.current = null;
  }
  poll(): number[] {
    const out: number[] = [];
    if (!this.ext) return out;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) out.push(Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6);
      gl.deleteQuery(q);
    }
    return out;
  }
}
