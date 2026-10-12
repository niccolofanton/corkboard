// The public face of the library: an infinite canvas of image and video cards.
//
//   const board = await Corkboard.create(div, { theme: 'dark' });
//   board.add([{ media: { src: 'https://…/a.jpg' } }, …]);
//   board.layout.tidy();
//   board.camera.fit();
//   board.on('selection', ({ ids }) => …);
//   board.dispose();
//
// `create` mounts a WebGL canvas and a DOM overlay layer in `host` (which needs a size: it is observed)
// and sets `position: relative` on it if it was static.
import { EmbedLayer, type EmbedEvents, type EmbedOptions } from './embed/layer';
import { Emitter } from './events';
import { Interaction, type InteractionEvents, type InteractionOptions } from './interact/controller';
import { DEFAULT_SNAPPING, type SnapSettings } from './interact/snap';
import { elementBox } from './interact/geometry';
import { LayoutApi } from './LayoutApi';
import type { Camera, Rect } from './math';
import { createElement, kindOf, newId, sizeOf } from './model';
import type { OverlayFactory, Overlay } from './overlay';
import { Stage, type StageOptions } from './render/stage';
import { DARK_THEME, LIGHT_THEME, type Theme } from './render/theme';
import { Store } from './store';
import type { Element, ElementId, ElementInit, ElementPatch } from './types';
import { VideoLayer, type VideoOptions } from './video/layer';

export interface CorkboardOptions {
  // 'dark' (default), 'light', or a full `Theme`.
  theme?: Theme | 'dark' | 'light';
  // Background dot grid (default true).
  grid?: boolean;
  // Snapping while moving and resizing (default: guides on, grid off). `false` turns both off.
  snapping?: Partial<SnapSettings> | boolean;
  // Pointer, touch and keyboard handling (default on). `false` leaves the canvas to the host: drive the
  // camera with `board.camera` and the cards with the API.
  interaction?: boolean | InteractionOptions;
  // Video playback (see VideoOptions).
  video?: VideoOptions;
  // Embed cards (`media.embed`): live iframe limits and the poster / framing `resolve` hook.
  embeds?: EmbedOptions;
  // Texture pipeline knobs.
  textures?: Pick<StageOptions, 'budgetBytes' | 'workers' | 'workerUrl' | 'uploadBudgetMs' | 'overscan' | 'softCanvas'>;
  // Extra DOM overlays (a new element kind that needs live DOM).
  overlays?: OverlayFactory[];
  // Load Pixi's CSP-safe build (no `new Function`).
  cspSafe?: boolean;
  // Time each GPU render (EXT_disjoint_timer_query_webgl2) for `stats()`.
  gpuTimer?: boolean;
}

export interface CorkboardEvents extends InteractionEvents, EmbedEvents {
  // Elements were added, changed or removed (from the API or from a gesture).
  change: { added: readonly Element[]; updated: readonly Element[]; removed: readonly Element[] };
  // The camera moved (every frame of a move).
  camera: { camera: Camera };
  // The camera has been still for a moment.
  cameraSettled: { camera: Camera };
}

export interface CameraOptions {
  // Animate the move (default true).
  animate?: boolean;
  // Screen px kept free around the target (default 48).
  padding?: number;
}

export class CameraApi {
  constructor(private readonly stage: Stage) {}

  get(): Camera {
    return { ...this.stage.cam.cam };
  }

  set(c: Camera): void {
    this.stage.setCamera(c);
  }

  // Fits the given cards (default: all) in the view.
  fit(ids?: readonly ElementId[], o: CameraOptions = {}): void {
    this.stage.fitRect(() => this.stage.contentBounds(ids), o.animate ?? true, o.padding ?? 48);
  }

  // Fits a world rectangle in the view.
  zoomTo(r: Rect, o: CameraOptions = {}): void {
    this.stage.fitRect(r, o.animate ?? true, o.padding ?? 48);
  }

  zoomBy(k: number): void {
    this.stage.zoomBy(k);
  }

  // 100 % about the middle of the view.
  actual(): void {
    this.stage.zoomToActual();
  }

  // Centres the view on a world point, optionally at a given zoom.
  center(x: number, y: number, scale?: number, o: CameraOptions = {}): void {
    const s = scale ?? this.stage.cam.scale;
    const c: Camera = {
      scale: s,
      tx: this.stage.cam.width / 2 - x * s,
      ty: this.stage.cam.height / 2 - y * s,
    };
    if (o.animate ?? true) this.stage.cam.flyTo(c);
    else this.stage.setCamera(c);
  }

  // The world rectangle in view.
  visible(): Rect {
    return this.stage.cam.visibleRect();
  }

  screenToWorld(x: number, y: number): { x: number; y: number } {
    return this.stage.screenToWorld(x, y);
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    return this.stage.worldToScreen(x, y);
  }
}

const THEMES = { dark: DARK_THEME, light: LIGHT_THEME } as const;
const themeOf = (t: CorkboardOptions['theme']): Theme =>
  t === undefined ? DARK_THEME : typeof t === 'string' ? THEMES[t] : t;

export class Corkboard {
  readonly store = new Store();
  readonly camera: CameraApi;
  readonly layout: LayoutApi;
  // The render stage and the interaction layer, for advanced use (and the demo's stats panel).
  readonly stage: Stage;
  readonly interaction: Interaction | null;

  private readonly emitter = new Emitter<CorkboardEvents>();
  private readonly snapSettings: SnapSettings;
  private readonly overlayRoot: HTMLElement;
  private readonly videoLayer: VideoLayer;
  // The live iframes of the `embed` cards (see src/embed/layer.ts).
  readonly embeds: EmbedLayer;
  private readonly overlays: Overlay[] = [];
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  static async create(host: HTMLElement, options: CorkboardOptions = {}): Promise<Corkboard> {
    const stage = await Stage.create(host, {
      ...options.textures,
      theme: themeOf(options.theme),
      grid: options.grid,
      gpuTimer: options.gpuTimer,
      cspSafe: options.cspSafe,
    });
    return new Corkboard(host, stage, options);
  }

  private constructor(
    host: HTMLElement,
    stage: Stage,
    options: CorkboardOptions,
  ) {
    this.stage = stage;
    stage.attach(this.store);
    this.camera = new CameraApi(stage);
    this.layout = new LayoutApi(this.store, stage);

    const sn = options.snapping;
    this.snapSettings =
      sn === false
        ? { guides: false, grid: false }
        : { ...DEFAULT_SNAPPING, ...(typeof sn === 'object' ? sn : {}) };

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this.overlayRoot = document.createElement('div');
    Object.assign(this.overlayRoot.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    host.appendChild(this.overlayRoot);

    this.videoLayer = new VideoLayer({ root: this.overlayRoot, store: this.store, stage }, options.video);
    this.embeds = new EmbedLayer(
      {
        root: this.overlayRoot,
        host,
        store: this.store,
        stage,
        emit: (type, payload) => this.emitter.emit(type, payload as CorkboardEvents[typeof type]),
      },
      options.embeds,
    );
    for (const make of options.overlays ?? []) {
      this.overlays.push(make({ root: this.overlayRoot, store: this.store, stage }));
    }

    this.cleanups.push(
      stage.onFrame((camChanged) => {
        this.videoLayer.onFrame(camChanged);
        this.embeds.onFrame(camChanged);
        for (const o of this.overlays) o.onFrame?.(camChanged);
        if (camChanged) this.emitter.emit('camera', { camera: { ...stage.cam.cam } });
      }),
      stage.onSettle(() => {
        this.videoLayer.onSettle();
        this.embeds.onSettle();
        for (const o of this.overlays) o.onSettle?.();
        this.emitter.emit('cameraSettled', { camera: { ...stage.cam.cam } });
      }),
      this.store.subscribe((e) => {
        if (e.type !== 'change') return;
        const c = e.change;
        this.emitter.emit('change', {
          added: c.added,
          updated: c.updated.map((u) => u.el),
          removed: c.removed,
        });
      }),
    );

    if (options.interaction !== false) {
      const iopts = typeof options.interaction === 'object' ? options.interaction : {};
      const it = new Interaction(host, stage, this.store, this.snapSettings, iopts);
      this.interaction = it;
      // Interaction events are the board's events.
      const forward = <K extends keyof InteractionEvents>(type: K): void => {
        this.cleanups.push(it.events.on(type, (p) => this.emitter.emit(type, p as CorkboardEvents[K])));
      };
      for (const t of [
        'selection',
        'hover',
        'click',
        'dblclick',
        'transform',
        'gesture',
        'touch',
        'delete',
      ] as const) {
        forward(t);
      }
      this.cleanups.push(
        it.events.on('hover', ({ id }) => {
          const el = id ? this.store.get(id) : undefined;
          this.videoLayer.setHover(el && el.media.video ? el.id : null);
        }),
        it.events.on('selection', ({ ids }) => {
          this.videoLayer.setSelection(ids);
          this.embeds.setSelection(ids);
        }),
        it.events.on('touch', ({ touch }) => {
          this.videoLayer.setTouch(touch);
          this.embeds.setTouch(touch);
        }),
        it.events.on('dblclick', ({ id }) => this.embeds.onDblClick(id)),
      );
    } else {
      this.interaction = null;
    }
  }

  // ── Elements ───────────────────────────────────────────────────────────────
  // Adds cards and returns their ids. A card with no `x` / `y` is placed on a free spot near the middle
  // of what is on screen, together with the others that have none, as one masonry block.
  add(input: ElementInit | readonly ElementInit[]): ElementId[] {
    const inits: readonly ElementInit[] = Array.isArray(input) ? input : [input as ElementInit];
    const els: Element[] = [];
    const unplaced: Element[] = [];
    const fixedSize = new Set<ElementId>();
    for (const init of inits) {
      const id = init.id ?? newId();
      const el = createElement(init, id);
      els.push(el);
      if (init.x === undefined || init.y === undefined) {
        unplaced.push(el);
        if (init.w !== undefined || init.h !== undefined) fixedSize.add(id);
      }
    }
    this.layout.placeNew(unplaced, fixedSize);
    this.store.add(els);
    return els.map((e) => e.id);
  }

  // Changes a card. Returns false when there is no such card.
  update(id: ElementId, patch: ElementPatch): boolean {
    if (!this.store.has(id)) return false;
    const p = { ...patch };
    // A new media with no explicit size keeps the card's width and takes the new aspect.
    if (p.media && p.w === undefined && p.h === undefined) {
      const cur = this.store.get(id) as Element;
      const size = sizeOf({ media: p.media, w: cur.w }, p.kind ?? cur.kind);
      if (p.media.aspect !== undefined || p.media.thumbhash !== undefined) p.h = size.h;
    }
    if (p.media && !p.kind) p.kind = kindOf({ media: p.media });
    this.store.update(id, p);
    return true;
  }

  // Removes cards; returns how many existed.
  remove(ids: ElementId | readonly ElementId[]): number {
    const list = typeof ids === 'string' ? [ids] : ids;
    return this.store.remove(list).length;
  }

  clear(): void {
    this.interaction?.setSelection([]);
    this.store.clear();
  }

  get(id: ElementId): Element | undefined {
    return this.store.get(id);
  }

  all(): Element[] {
    return [...this.store.elements()];
  }

  get size(): number {
    return this.store.size;
  }

  // The ids of the cards whose box meets a world rectangle.
  inRect(r: Rect): ElementId[] {
    return this.store
      .searchInto({ minX: r.x0, minY: r.y0, maxX: r.x1, maxY: r.y1 }, [])
      .map((e) => e.id);
  }

  // World rectangle covering the given cards (default: all).
  bounds(ids?: readonly ElementId[]): Rect {
    return this.stage.contentBounds(ids);
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  get selection(): readonly ElementId[] {
    return this.interaction?.selection ?? [];
  }

  select(ids: readonly ElementId[]): void {
    this.interaction?.setSelection(ids);
  }

  selectAll(): void {
    this.interaction?.setSelection([...this.store.ids()]);
  }

  clearSelection(): void {
    this.interaction?.setSelection([]);
  }

  // The selected cards when two or more are, else all of them: what an "arrange" button should act on.
  get arrangeTargets(): readonly ElementId[] | undefined {
    return this.selection.length >= 2 ? this.selection : undefined;
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  setTheme(theme: Theme | 'dark' | 'light'): void {
    this.stage.setTheme(themeOf(theme));
    this.embeds.setTheme();
  }

  setGrid(on: boolean): void {
    this.stage.setGrid(on);
  }

  // Alignment guides / snap to the background grid while moving and resizing.
  setSnapping(s: Partial<SnapSettings> | boolean): void {
    if (typeof s === 'boolean') {
      this.snapSettings.guides = s;
      this.snapSettings.grid = s;
    } else Object.assign(this.snapSettings, s);
  }

  get snapping(): Readonly<SnapSettings> {
    return this.snapSettings;
  }

  setVideo(o: VideoOptions): void {
    this.videoLayer.setOptions(o);
  }

  // Ids of the cards whose video plays now.
  get playing(): ReadonlySet<ElementId> {
    return this.videoLayer.playing;
  }

  // Pauses every video (a lightbox open over the canvas, say).
  setVideoPaused(paused: boolean): void {
    this.videoLayer.setPaused(paused);
  }

  // Embed cards: live iframe limits (`maxLive`, `maxLiveTouch`, `minLivePx`) and the `resolution` of the
  // virtual screen pages are laid out at can change at any time.
  setEmbeds(o: EmbedOptions): void {
    this.embeds.setOptions(o);
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  on<K extends keyof CorkboardEvents>(type: K, fn: (payload: CorkboardEvents[K]) => void): () => void {
    return this.emitter.on(type, fn);
  }

  off<K extends keyof CorkboardEvents>(type: K, fn: (payload: CorkboardEvents[K]) => void): void {
    this.emitter.off(type, fn);
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────
  // Render loop counters and timings (rAF callbacks, mounted views, texture memory, percentiles).
  stats(): Record<string, unknown> {
    return {
      ...this.stage.stats(),
      embedsLive: this.embeds.live.size,
      embedsMaxLive: this.embeds.maxLive,
    };
  }

  // Bounding box of a card on screen, in host-local px (for HTML UI pinned to a card).
  screenRect(id: ElementId): { x: number; y: number; w: number; h: number } | null {
    const el = this.store.get(id);
    if (!el) return null;
    const b = elementBox(el);
    const a = this.stage.worldToScreen(b.minX, b.minY);
    const k = this.stage.cam.scale;
    return { x: a.x, y: a.y, w: (b.maxX - b.minX) * k, h: (b.maxY - b.minY) * k };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.interaction?.dispose();
    for (const f of this.cleanups) f();
    this.videoLayer.dispose();
    this.embeds.dispose();
    for (const o of this.overlays) o.dispose();
    this.overlayRoot.remove();
    this.stage.dispose();
    this.emitter.clear();
  }
}
