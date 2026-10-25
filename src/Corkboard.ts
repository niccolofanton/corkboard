import { EmbedLayer, type EmbedEvents, type EmbedOptions } from './embed/layer';
import { clearPreviewCache } from './embed/previewCache';
import { CorkboardError, type BoardErrorEvent } from './errors';
import { Emitter } from './events';
import type { CameraApi, EmbedsApi, InteractionApi, LayoutApi, VideoApi } from './api';
import { BoardCamera } from './BoardCamera';
import { assertRect, bad, boolean, idList, show } from './check';
import { Interaction, type InteractionEvents, type InteractionOptions } from './interact/controller';
import { registerInternals } from './internals';
import { DEFAULT_SNAPPING, type SnapSettings } from './interact/snap';
import { elementBox } from './interact/geometry';
import { BoardLayout } from './BoardLayout';
import type { Camera, Rect, Box } from './math';
import {
  assertRange,
  checkCreateOptions,
  checkEmbedOptions,
  checkInteractionOptions,
  checkSnapping,
  checkVideoOptions,
  resolveTheme,
} from './options';
import { applyChangeTo, type ApplyChangeOptions } from './change';
import { copyMedia, createElement, kindOf, newId, sizeOf } from './model';
import { FrameRateMonitor } from './render/frameRate';
import { Stage } from './render/stage';
import type { Theme } from './render/theme';
import { fromSnapshot, toSnapshot, type BoardSnapshot, type BoardSnapshotInput } from './snapshot';
import type { BoardStats } from './stats';
import { Store } from './store';
import { MAX_SCALE, MIN_SCALE } from './types';
import type { Change, ChangeSource, Card, CardId, CardInit, CardPatch, OrderChange } from './types';
import { validateChange, validateInits, validatePatch } from './validate';
import { VideoLayer, type VideoOptions } from './video/layer';

/** The texture pipeline's options (`CorkboardOptions.textures`). Every one is optional. Create-only: the pipeline is built once, per board. */
export interface TextureOptions {
  /**
   * GPU texture memory budget in bytes (a finite number > 0). Use ~128 MB on small devices.
   * @default 268435456 (256 MB)
   */
  budgetBytes?: number;
  /**
   * Decode workers.
   * @default a quarter of the cores, 1..4
   */
  workers?: number;
  /**
   * URL of the decode worker script, for pages whose CSP forbids `worker-src blob:` (the built-in worker is
   * inlined and started from a blob URL). Serve `@niccolofanton/corkboard/decode.worker.js` yourself and pass
   * its URL here.
   */
  workerUrl?: string | URL;
  /**
   * Per-frame texture upload budget, ms.
   * @default 4
   */
  uploadBudgetMs?: number;
  /**
   * How far past the viewport textures are prepared, as a fraction of the viewport added on every side.
   * @default 0.5
   */
  overscan?: number;
  /**
   * Bake the rounded corners in a software canvas in the workers. Measured about 2x slower to load.
   * @default false
   */
  softCanvas?: boolean;
}

/** The zoom range of the camera (`CorkboardOptions.camera`). Both limits are optional. */
export interface CameraRange {
  /**
   * Lowest zoom. Lower it for a board that is much wider than the screen and must still fit whole.
   * @default 0.05
   */
  minScale?: number;
  /**
   * Highest zoom.
   * @default 4
   */
  maxScale?: number;
}

/**
 * Options of {@link Corkboard.create}. Every one is optional, and each is checked up front: a bad value (a NaN or
 * negative limit, an unknown theme name or enum value...) rejects `create` with `CorkboardError('invalid')`.
 *
 * Changeable later: `theme` (`setTheme`), `grid` (`setGrid`), `snapping` (`setSnapping`), `video`
 * (`video.setOptions`), `embeds` (`embeds.setOptions`), `camera` (`camera.setRange`) and the options of an
 * `interaction` object (`interaction.setOptions`). Create-only: `interaction` on / off, `textures`, `cspSafe`,
 * `nonce`, `gpuTimer` and `signal`.
 */
export interface CorkboardOptions {
  /**
   * `'dark'`, `'light'`, or a full {@link Theme}.
   * @default 'dark'
   */
  theme?: Theme | 'dark' | 'light';
  /**
   * Background dot grid.
   * @default true
   */
  grid?: boolean;
  /**
   * Snapping while moving and resizing. `false` turns guides and grid off, `true` turns both on.
   * @default { guides: true, grid: false }
   */
  snapping?: Partial<SnapSettings> | boolean;
  /**
   * Pointer, touch and keyboard handling. `false` leaves the canvas to the host: drive the camera with
   * `board.camera` and the cards with the API (and `board.interaction` is `null`).
   * @default true
   */
  interaction?: boolean | InteractionOptions;
  /** Video playback: mode, loop, mute and how many clips play at once. */
  video?: VideoOptions;
  /** Embed cards (`media.embed`): live iframe limits, the `resolve` hook and the security options. */
  embeds?: EmbedOptions;
  /** Texture pipeline: memory budget, decode workers, upload budget. */
  textures?: TextureOptions;
  /** The zoom range of the camera (`0 < minScale <= maxScale`, else `create` rejects with `'invalid'`; `camera.setRange` changes it later). */
  camera?: CameraRange;
  /**
   * Load Pixi's CSP-safe build, which does not use `new Function`. Needed under a CSP without `'unsafe-eval'`.
   * @default false
   */
  cspSafe?: boolean;
  /**
   * Nonce for the `<style>` elements the board injects (the embed layer's and the video layer's), for a CSP
   * with a nonce-based `style-src`. The styles are shared by the boards on a document and removed when the
   * last one is disposed.
   */
  nonce?: string;
  /**
   * Time each GPU render (`EXT_disjoint_timer_query_webgl2`): `stats().render.gpuMs` and the `render` event's
   * `gpuMs`. Off by default: the timer queries are not free.
   * @default false
   */
  gpuTimer?: boolean;
  /**
   * Cancels a pending `create` (React StrictMode mounts, unmounts and mounts again before the first board is
   * up): if it aborts before `create` resolves, the half-made board is disposed and `create` rejects with
   * `signal.reason`. Once the board exists the signal does nothing: call `dispose()`.
   */
  signal?: AbortSignal;
}

/**
 * The events of a board, for {@link Corkboard.on}. The interaction events (`selection`, `hover`, `click`,
 * `dblclick`, `transform`, `gesture`, `touch`, `delete`) are emitted only when `interaction` is not `false`.
 */
export interface CorkboardEvents extends InteractionEvents, EmbedEvents {
  /**
   * Cards were added, changed or removed: one event per API call, per gesture commit, per `batch` and per
   * `loadSnapshot`. It is the NET difference between the board before and after: a card id appears in at most
   * one of `added`, `removed` and `updated`.
   * - add then remove of a card in one batch: nothing; remove then add of the same id: one update (`prev` is the
   *   card that was there); add then update: one add with the final card.
   * - `updated` entries run from the first `prev` to the last `el`; a card that ends up as it started is not
   *   there, and a batch with no net change emits no event.
   * - `loadSnapshot` follows the same rules: a card with the same id becomes an update, an unchanged card is
   *   not reported.
   *
   * `source` says who: a gesture (`'user'`), a call on the board or on `board.layout` (`'api'`), `loadSnapshot`
   * (`'load'`), `applyChange` (`'apply'`, or `'undo'` when inverted), the library itself (`'system'`, e.g. an
   * embed resized to its content), or the tag a host gave `batch(fn, { source })`. When recording history or
   * broadcasting, skip `'system'`, `'undo'` and `'apply'`.
   *
   * `order` is present when the draw order changed other than by cards appended on top: a card brought to the
   * front, a reorder, a removal. It lists the cards that moved with the card below each one before and after
   * (see {@link OrderChange}), not whole id lists. A drag is ONE event: the move and the bring-to-front.
   *
   * The payload is a {@link Change}: keep it, `invertChange` it, replay it with {@link Corkboard.applyChange}.
   */
  change: Change;
  /**
   * A frame was rendered (not emitted while the board is idle): the main-thread time of the render call and
   * the GPU timer results that arrived meanwhile, in ms. GPU results come back a few frames late, so `gpuMs`
   * holds the timings of earlier frames (0, 1 or several), and is always empty unless `gpuTimer: true`.
   */
  render: { cpuMs: number; gpuMs: readonly number[] };
  /** The camera moved (emitted every frame of a move). */
  camera: { camera: Camera };
  /** The camera has been still for a moment. */
  cameraSettled: { camera: Camera };
  /**
   * Something failed at runtime without throwing: a picture or video that would not load, a dead decode
   * worker, an embed lookup that failed, the WebGL context lost (`kind: 'context'`, together with
   * `contextLost`). The card stays on its placeholder.
   */
  error: BoardErrorEvent;
  /** The WebGL context was lost: nothing is drawn until `contextRestored` (the textures then reload). */
  contextLost: Record<string, never>;
  /** The WebGL context is back and the textures reload by themselves. */
  contextRestored: Record<string, never>;
}

/**
 * An infinite canvas of image, video and embed cards, drawn with WebGL.
 *
 * Make one with {@link Corkboard.create}; it mounts a canvas and a DOM overlay layer in the host and runs until
 * `dispose()`. After `dispose()` every method throws a {@link CorkboardError} (`'disposed'`) except `off`
 * (a no-op) and the getters, which keep the last state.
 *
 * @example
 * ```ts
 * const board = await Corkboard.create(div, { theme: 'dark' });
 * board.add([{ media: { src: 'https://example.com/a.jpg' } }]);
 * board.layout.tidy();
 * board.camera.fit();
 * board.on('selection', ({ ids }) => console.log(ids));
 * // later
 * board.dispose();
 * ```
 */
export class Corkboard {
  /** Camera control: pan, zoom, fit and the world / screen conversions. */
  readonly camera: CameraApi;
  /** Auto layout: tidy, masonry, align, distribute, equal width. */
  readonly layout: LayoutApi;
  /** The live iframes of the `embed` cards: what is mounted, what is known about a card, interact mode, their options. */
  readonly embeds: EmbedsApi;
  /** Video playback: what plays, the budget, pause, the options. */
  readonly video: VideoApi;
  /** The pointer, touch and keyboard layer (`null` with `interaction: false`). */
  readonly interaction: InteractionApi | null;

  // The parts below are reached with `getInternals` from `@niccolofanton/corkboard/unstable`.
  private readonly store = new Store();
  private readonly stage: Stage;
  private readonly layoutCtl: BoardLayout;
  private readonly input: Interaction | null;

  private readonly emitter: Emitter<CorkboardEvents>;
  private readonly snapSettings: SnapSettings;
  private readonly overlayRoot: HTMLElement;
  private readonly videoLayer: VideoLayer;
  // Measures the page's frame rate in short bursts for the layers that shed load when it is slow.
  private readonly frameRate = new FrameRateMonitor();
  // The live iframes of the `embed` cards (see src/embed/layer.ts).
  private readonly embedLayer: EmbedLayer;
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  /** Whether this browser can run a board: a WebGL2 context can be made. Never throws. */
  static isSupported(): boolean {
    try {
      if (typeof document === 'undefined') return false;
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      if (!gl) return false;
      // Hand the context back at once: browsers allow only a handful per page.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletes the Cache Storage entry that keeps the rendered previews of HTML snippets.
   *
   * @param name The `embeds.previewCache` name, if you set one. Default: the default cache and the one
   *   version 0.1 used.
   * @returns Resolves when done. Never throws, and does nothing where Cache Storage does not exist. Boards
   *   already open keep the previews they hold in memory.
   */
  static clearPreviewCache(name?: string): Promise<void> {
    return clearPreviewCache(name);
  }

  /**
   * Creates a board in `host`: mounts a WebGL canvas and a DOM overlay layer in it, and sets `position:
   * relative` on the host if it was static. The host needs a size (it is observed).
   *
   * @param host The element to draw in.
   * @param options See {@link CorkboardOptions}.
   * @throws {CorkboardError} `'invalid'` when `host` is not an element or an option holds a value it cannot use
   *   (an unknown theme name, a NaN or negative limit, a zoom range with `minScale > maxScale`...); nothing is made.
   * @throws {CorkboardError} `'unsupported'` when the browser cannot run WebGL2.
   * @throws The `signal`'s reason, if it aborts before the board is up.
   * @example
   * ```ts
   * const ctl = new AbortController();
   * const board = await Corkboard.create(host, { theme: 'light', signal: ctl.signal });
   * ```
   */
  static async create(host: HTMLElement, opts: CorkboardOptions = {}): Promise<Corkboard> {
    const options = checkCreateOptions(host, opts);
    const { signal } = options;
    if (signal?.aborted) throw signal.reason;
    const minScale = options.camera?.minScale ?? MIN_SCALE;
    const maxScale = options.camera?.maxScale ?? MAX_SCALE;
    assertRange('Corkboard.create: camera option', minScale, maxScale);
    // The stage reports before the board exists to hold the listeners: they share this emitter.
    const emitter = new Emitter<CorkboardEvents>();
    const stage = await Stage.create(host, {
      ...options.textures,
      theme: resolveTheme('Corkboard.create: option "theme"', options.theme),
      grid: options.grid,
      gpuTimer: options.gpuTimer,
      cspSafe: options.cspSafe,
      minScale,
      maxScale,
      signal,
      onError: (e) => emitter.emit('error', e),
      onRender: (e) => emitter.emit('render', e),
      onContextLost: () => emitter.emit('contextLost', {}),
      onContextRestored: () => emitter.emit('contextRestored', {}),
    });
    if (signal?.aborted) {
      stage.dispose();
      throw signal.reason;
    }
    try {
      return new Corkboard(host, stage, options, emitter);
    } catch (err) {
      stage.dispose();
      throw err;
    }
  }

  private constructor(
    host: HTMLElement,
    stage: Stage,
    options: CorkboardOptions,
    emitter: Emitter<CorkboardEvents>,
  ) {
    this.stage = stage;
    this.emitter = emitter;
    const alive = (): void => this.alive();
    this.camera = new BoardCamera(stage, this.store, alive);
    this.layoutCtl = new BoardLayout(this.store, stage, alive);
    this.layout = this.layoutCtl;
    try {
      stage.attach(this.store);
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

      this.videoLayer = new VideoLayer(
        {
          root: this.overlayRoot,
          store: this.store,
          stage,
          frameRate: this.frameRate,
          nonce: options.nonce,
          onError: (e) => this.emitter.emit('error', e),
        },
        options.video,
      );
      const videoLayer = this.videoLayer;
      this.video = {
        get playing() {
          return videoLayer.playing;
        },
        get budget() {
          return videoLayer.playingBudget;
        },
        get paused() {
          return videoLayer.isPaused;
        },
        setPaused: (paused) => {
          this.alive();
          boolean('video.setPaused', 'paused', paused);
          videoLayer.setPaused(paused);
        },
        setOptions: (o) => {
          this.alive();
          videoLayer.setOptions(checkVideoOptions('video.setOptions', o));
        },
      };
      const embedLayer = new EmbedLayer(
        {
          root: this.overlayRoot,
          host,
          store: this.store,
          stage,
          frameRate: this.frameRate,
          nonce: options.nonce,
          emit: (type, payload) => this.emitter.emit(type, payload as CorkboardEvents[typeof type]),
        },
        options.embeds,
      );
      this.embedLayer = embedLayer;
      this.embeds = {
        get live() {
          return embedLayer.live;
        },
        get interacting() {
          return embedLayer.interacting;
        },
        info: (id) => {
          this.alive();
          return embedLayer.info(id) ?? undefined;
        },
        setOptions: (o) => {
          this.alive();
          embedLayer.setOptions(checkEmbedOptions('embeds.setOptions', o));
        },
        interact: (id) => {
          this.alive();
          return embedLayer.interact(id);
        },
        exitInteract: () => {
          this.alive();
          embedLayer.exitInteract();
        },
      };

      this.cleanups.push(
        stage.onFrame((camChanged) => {
          this.videoLayer.onFrame(camChanged);
          this.embedLayer.onFrame(camChanged);
          if (camChanged) this.emitter.emit('camera', { camera: { ...stage.cam.cam } });
        }),
        stage.onSettle(() => {
          this.videoLayer.onSettle();
          this.embedLayer.onSettle();
          // Still camera: the cheapest moment to see what the page really costs.
          this.frameRate.poke();
          this.emitter.emit('cameraSettled', { camera: { ...stage.cam.cam } });
        }),
      );

      if (options.interaction !== false) {
        const iopts = typeof options.interaction === 'object' ? options.interaction : {};
        const it = new Interaction(host, stage, this.store, this.snapSettings, iopts);
        this.input = it;
        this.interaction = {
          setPanMode: (on) => {
            this.alive();
            boolean('interaction.setPanMode', 'on', on);
            it.setPanMode(on);
          },
          setOptions: (o) => {
            this.alive();
            it.setOptions(checkInteractionOptions('interaction.setOptions', o));
          },
        };
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
            this.embedLayer.setSelection(ids);
          }),
          it.events.on('touch', ({ touch }) => {
            this.videoLayer.setTouch(touch);
            this.embedLayer.setTouch(touch);
          }),
          it.events.on('dblclick', ({ id }) => this.embedLayer.onDblClick(id)),
        );
      } else {
        this.input = null;
        this.interaction = null;
      }
      // The public `change` event goes out LAST among the store's listeners (the stage, the layers and the
      // interaction layer subscribed before): by the time host code runs, the selection has dropped the cards
      // that left and every layer has seen the change.
      this.cleanups.push(
        this.store.subscribe((e) => {
          const c = e.change;
          const out: CorkboardEvents['change'] = {
            source: c.source,
            added: c.added,
            removed: c.removed,
            updated: c.updated,
          };
          if (c.order) out.order = c.order;
          this.emitter.emit('change', out);
        }),
      );
      registerInternals(this, {
        stage,
        store: this.store,
        interaction: this.input,
        embeds: this.embedLayer,
        video: this.videoLayer,
        overlayRoot: this.overlayRoot,
        isDisposed: () => this.disposed,
        onDispose: (fn) => {
          this.cleanups.push(fn);
          return () => {
            const i = this.cleanups.indexOf(fn);
            if (i >= 0) this.cleanups.splice(i, 1);
          };
        },
      });
    } catch (err) {
      // A later step threw: let go of what was already made. The stage is the caller's (`create` disposes it).
      this.disposed = true;
      this.teardown();
      throw err;
    }
  }

  // ── Elements ───────────────────────────────────────────────────────────────
  /**
   * Adds cards and returns their ids. A card with no `x` / `y` is placed on a free spot near the middle of what
   * is on screen, together with the others that have none, as one masonry block. Its size is the one it was
   * given, or its kind's default if that has a width of its own (embeds); an `x` or `y` it came with is kept,
   * the other coordinate is placed.
   *
   * @param input One card or an array of them. Pass thousands as ONE array: each call places its unplaced cards
   *   against the whole board. `media` is copied (and a `Uint8Array` thumbhash stored as base64): changing the
   *   object you passed afterwards does not touch the card or the history.
   * @returns The ids, in order.
   * @throws {CorkboardError} `'invalid'` on a value a card cannot hold (a NaN, a size <= 0, a duplicate id, an
   *   embed with both or neither of `url` / `html`...). Nothing was added, whatever the batch.
   */
  add(input: CardInit | readonly CardInit[]): CardId[] {
    this.alive();
    const inits: readonly CardInit[] = Array.isArray(input) ? input : [input as CardInit];
    validateInits(inits, (id) => this.store.has(id));
    const els: Card[] = [];
    const unplaced: Card[] = [];
    const fixedSize = new Set<CardId>();
    const given = new Map<CardId, { x?: number; y?: number }>();
    for (const init of inits) {
      const id = init.id ?? newId();
      const el = createElement(init, id);
      els.push(el);
      if (init.x === undefined || init.y === undefined) {
        unplaced.push(el);
        if (init.w !== undefined || init.h !== undefined || el.kind === 'embed') fixedSize.add(id);
        if (init.x !== undefined || init.y !== undefined) given.set(id, { x: init.x, y: init.y });
      }
    }
    this.layoutCtl.placeNew(unplaced, fixedSize, given);
    this.store.add(els);
    return els.map((e) => e.id);
  }

  /**
   * Changes a card. A field left out, or set to `undefined`, is left as it is - except `data`: a patch with an
   * own `data` key set to `undefined` clears it (`{ data: undefined }`; `{ data: null }` stores `null`).
   * `media` is copied, with a `Uint8Array` thumbhash stored as base64. A new `media` with an `aspect` or a
   * `thumbhash` and no `w` / `h` in the patch keeps the card's width and takes the new height.
   *
   * @returns `false` when there is no such card.
   * @throws {CorkboardError} `'invalid'` on a value a card cannot hold; nothing changed.
   */
  update(id: CardId, patch: CardPatch): boolean {
    this.alive();
    if (!this.store.has(id)) return false;
    validatePatch(id, patch);
    const p = { ...patch };
    // A new media with no explicit size keeps the card's width and takes the new aspect.
    if (p.media && p.w === undefined && p.h === undefined) {
      const cur = this.store.get(id) as Card;
      const size = sizeOf({ media: p.media, w: cur.w }, p.kind ?? cur.kind);
      if (p.media.aspect !== undefined || p.media.thumbhash !== undefined) p.h = size.h;
    }
    if (p.media && !p.kind) p.kind = kindOf({ media: p.media });
    const next: Record<string, unknown> = { ...p };
    if (p.media) next.media = copyMedia(p.media);
    this.store.update(id, next as CardPatch);
    return true;
  }

  /**
   * Removes cards.
   *
   * @param ids One id or a list of ids.
   * @returns How many of the ids existed.
   * @throws {CorkboardError} `'invalid'` when `ids` is not a string or an array of strings.
   */
  remove(ids: CardId | readonly CardId[]): number {
    this.alive();
    return this.store.remove(idList('remove', ids)).length;
  }

  /** Removes every card and clears the selection. */
  clear(): void {
    this.alive();
    this.input?.setSelection([]);
    this.store.clear();
  }

  /**
   * Runs `fn` and emits ONE `change` event for everything it did (`add`, `update`, `remove`, `loadSnapshot`,
   * `applyChange`, `board.layout.*`, the z-order methods): the net difference, see {@link CorkboardEvents}. Batches nest: an
   * inner one folds into the outer. Reads inside `fn` see every change made so far. `fn` must be synchronous.
   *
   * If `fn` throws there is no rollback: what it already did stays, the event for it is still emitted (after
   * `fn` stopped), and `fn`'s error is the one rethrown - a listener that throws does not replace it.
   *
   * @param opts `source` tags the event (see `ChangeSource`); default `'api'`. With nested batches the
   *   outermost one that names a source wins; `'load'` (from `loadSnapshot`) wins over any.
   */
  batch(fn: () => void, opts: { source?: ChangeSource } = {}): void {
    this.alive();
    this.store.batch(fn, opts.source);
  }

  /**
   * Replays a {@link Change} (or its inverse) on the board: the one primitive behind undo, redo and sync.
   *
   * ```ts
   * board.on('change', (c) => { if (!['system', 'undo', 'apply'].includes(c.source)) undoStack.push(c); });
   * board.applyChange(undoStack.pop()!, { invert: true });   // undo
   * board.applyChange(redoChange);                           // redo / apply a peer's change (JSON round trip is fine)
   * ```
   *
   * First every value is validated (`'invalid'` on a bad one, nothing changed; with `invert`, the inverse is what is checked; an id may not repeat in `added`, `removed` or `updated`, nor be both added and removed), then ONE batch (one `change`
   * event) does, in this order:
   * 1. `removed` cards are removed (ids that are not on the board are skipped).
   * 2. `added` cards are upserted exactly as given: no placement, no default size; an id already on the board is
   *    overwritten in place.
   * 3. `updated` entries write each field of `props` from `el` as it is (no height is derived from the media's
   *    aspect; a field that is `undefined` - `data` cleared - clears it). A card that is gone is skipped. With
   *    `conflict: 'skip'` (the default for an inverted change) a field is written only if the card still holds
   *    the value the change started from (`prev`), compared structurally.
   * 4. `order.moved` is replayed bottom first: each card goes directly above its `nextBelow` (`null`: the
   *    bottom). An entry whose card or anchor is not on the board is skipped. A card that was only appended on
   *    top is not in `order`, so redoing such an `add` puts it on top.
   *
   * It does not touch the camera or the selection: those are the host's. The result is a pure function of the
   * change and the board, so peers that start equal and replay the same changes stay equal.
   *
   * @param c A change from the `change` event, or its JSON round trip.
   * @param opts See {@link ApplyChangeOptions}.
   * @throws {CorkboardError} `'invalid'` when the change holds a value a card cannot hold, or repeats an id; nothing changed.
   */
  applyChange(c: Change, opts: ApplyChangeOptions = {}): void {
    this.alive();
    validateChange(c, opts.invert === true);
    this.layoutCtl.cancelAnimation();
    applyChangeTo(this.store, c, opts);
  }

  /**
   * The cards and the camera as plain data, to persist or to restore with {@link Corkboard.loadSnapshot}: the
   * cards in draw order (bottom first), each as `add` took it plus the size and position the board gave it.
   *
   * The snapshot shares no object with the board: `media` is copied (so is a `Uint8Array` thumbhash, which
   * becomes base64). `data` is the exception, passed by reference: keep it JSON-safe, since `JSON.stringify`
   * of the snapshot walks it. `data` is also the place for what you need to persist beyond the card fields:
   * any new persisted field of the library bumps `SNAPSHOT_VERSION`, `data` never does. A `blob:` URL
   * (`media.src`, `video`, `sizes`) is left out, since it is dead after a reload. Not included: selection,
   * theme, grid, snapping, video and embed settings, runtime posters and snapshots, and the poster an embed
   * resolved (the `embedResolved` event's `poster`, or `embeds.info(id)?.posters[0]`): to keep that one, read it
   * and store it yourself, then `update(id, { media: { ...board.get(id)!.media, src: poster } })`.
   *
   * @param o `camera: false` leaves the camera out.
   */
  getSnapshot(o: { camera?: boolean } = {}): BoardSnapshot {
    this.alive();
    return toSnapshot(this.all(), o.camera === false ? undefined : { ...this.stage.cam.cam });
  }

  /**
   * Replaces the board with a snapshot (from {@link Corkboard.getSnapshot}, or `JSON.parse` of a saved one).
   *
   * All or nothing: the format, the version and every card are checked first with the same rules as `add`
   * (plus finite x / y and w / h > 0, required here) - a card `add` accepts, a snapshot accepts. Only `id`, `x`,
   * `y`, `w`, `h` and `media` are required: the other fields take the defaults of `add` (`kind` comes from
   * `media`). Keys a card does not have are dropped. Then the selection is cleared, a running layout animation and any drag or resize in progress end, and the cards are
   * swapped in one step with their ids, positions and order kept (nothing is auto-placed); `media` is copied,
   * `data` is taken by reference - except that a `data` structurally equal to the card's current one keeps the
   * current object, like `media`, so loading the same JSON twice emits nothing. The camera jumps to the snapshot's one, if it has one and `camera` is not
   * `false`. Emits at most one `change` event with `source: 'load'`, as a net diff (see {@link CorkboardEvents}):
   * cards with a new id are `added`, cards gone are `removed`, a card whose id is in both is an `updated` entry,
   * and one that did not change is not reported.
   *
   * @throws {CorkboardError} `'invalid'` when the snapshot is malformed or written by a newer corkboard than
   *   this build reads (`SNAPSHOT_VERSION`); nothing changed.
   */
  loadSnapshot(snapshot: BoardSnapshot | BoardSnapshotInput, o: { camera?: boolean } = {}): void {
    this.alive();
    const { elements, camera } = fromSnapshot(snapshot, (id) => this.store.get(id));
    this.input?.setSelection([]);
    this.layoutCtl.cancelAnimation();
    this.store.replaceAll(elements);
    if (camera && o.camera !== false) this.stage.setCamera(camera);
  }

  /** A card by id (`undefined`: none). The object is the store's: do not mutate it, use `update`. */
  get(id: CardId): Card | undefined {
    this.alive();
    return this.store.get(id);
  }

  /** Every card in draw order, bottom first: the order of `getSnapshot()`, and the one a gesture changes when it brings a card to the front. */
  all(): Card[] {
    this.alive();
    return this.store.ids().map((id) => this.store.get(id) as Card);
  }

  /**
   * Moves cards to the top of the draw order, keeping their relative order. Ids that are not on the board are
   * ignored. Throws `'invalid'` when `ids` is not a string or an array of strings.
   */
  bringToFront(ids: CardId | readonly CardId[]): void {
    this.alive();
    this.store.bringToFront(idList('bringToFront', ids));
  }

  /**
   * Moves cards to the bottom of the draw order, keeping their relative order. Ids that are not on the board are
   * ignored. Throws `'invalid'` when `ids` is not a string or an array of strings.
   */
  sendToBack(ids: CardId | readonly CardId[]): void {
    this.alive();
    this.store.sendToBack(idList('sendToBack', ids));
  }

  /**
   * Sets the whole draw order, bottom first.
   *
   * @param ids Every id on the board exactly once (as `all().map((e) => e.id)` returns them, reordered). An array
   *   only: unlike the other id lists it takes no single id.
   * @throws {CorkboardError} `'invalid'` when `ids` is not an array that is a permutation of the ids on the board; nothing changed.
   */
  setOrder(ids: readonly CardId[]): void {
    this.alive();
    if (!Array.isArray(ids)) bad('setOrder', `needs the full list of ids as an array (got ${show(ids)})`);
    this.store.setOrder(idList('setOrder', ids));
  }

  /** How many cards are on the board. */
  get size(): number {
    return this.store.size;
  }

  /** The ids of the cards whose box meets a world rectangle. */
  inRect(r: Rect): CardId[] {
    this.alive();
    assertRect('inRect', r);
    return this.store
      .searchInto({ minX: r.x0, minY: r.y0, maxX: r.x1, maxY: r.y1 }, [])
      .map((e) => e.id);
  }

  /**
   * The world rectangle covering the given cards (default: all).
   *
   * @param ids One id or a list of ids.
   * @returns `undefined` when there is nothing to cover: an empty board, or none of the ids is a card.
   * @throws {CorkboardError} `'invalid'` when `ids` is not a string or an array of strings.
   */
  bounds(ids?: CardId | readonly CardId[]): Rect | undefined {
    this.alive();
    return this.stage.boundsOf(idList('bounds', ids, true));
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  /** The selected card ids. Always empty with `interaction: false`. */
  get selection(): readonly CardId[] {
    return this.input?.selection ?? [];
  }

  /**
   * Selects exactly these cards (one id or a list; an empty array clears the selection) and emits `selection`.
   * Does nothing with `interaction: false`. Throws `'invalid'` when `ids` is not a string or an array of strings.
   *
   * For an "arrange" button: `board.layout.tidy(board.selection.length >= 2 ? board.selection : undefined)`.
   */
  select(ids: CardId | readonly CardId[]): void {
    this.alive();
    const list = idList('select', ids);
    this.input?.setSelection(list);
  }

  /** Selects every card. Does nothing with `interaction: false`. */
  selectAll(): void {
    this.alive();
    this.input?.setSelection([...this.store.ids()]);
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  /**
   * Switches the theme.
   *
   * @throws {CorkboardError} `'invalid'` for a name other than `'dark'` / `'light'` or a `Theme` that is missing
   *   a field or holds a bad colour.
   */
  setTheme(theme: Theme | 'dark' | 'light'): void {
    this.alive();
    if (theme === undefined) bad('setTheme', "theme must be 'dark', 'light' or a Theme object (got undefined)");
    this.stage.setTheme(resolveTheme('setTheme', theme));
    this.embedLayer.setTheme();
  }

  /** Shows or hides the background dot grid. Throws `'invalid'` unless `on` is a boolean. */
  setGrid(on: boolean): void {
    this.alive();
    boolean('setGrid', 'on', on);
    this.stage.setGrid(on);
  }

  /**
   * Alignment guides / snap to the background grid while moving and resizing. `true` / `false` set both. Throws
   * `'invalid'` for anything but a boolean or `{ guides?, grid? }` of booleans.
   */
  setSnapping(s: Partial<SnapSettings> | boolean): void {
    this.alive();
    checkSnapping('setSnapping', s);
    if (typeof s === 'boolean') {
      this.snapSettings.guides = s;
      this.snapSettings.grid = s;
    } else Object.assign(this.snapSettings, s);
  }

  /** The snapping settings now (a copy: change them with `setSnapping`). */
  get snapping(): Readonly<SnapSettings> {
    return { ...this.snapSettings };
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  /**
   * Subscribes to an event (see {@link CorkboardEvents}).
   *
   * @returns The function that unsubscribes.
   */
  on<K extends keyof CorkboardEvents>(type: K, fn: (payload: CorkboardEvents[K]) => void): () => void {
    this.alive();
    return this.emitter.on(type, fn);
  }

  /** Removes a listener added with `on`. Does nothing after `dispose()`. */
  off<K extends keyof CorkboardEvents>(type: K, fn: (payload: CorkboardEvents[K]) => void): void {
    this.emitter.off(type, fn);
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────
  /**
   * A snapshot of the counters and timings of the board: the render loop and its percentiles, texture memory
   * and the decode pipeline, the embeds and the videos (see {@link BoardStats}). Cheap enough to call twice a
   * second; it sorts the timing history, so not every frame (listen to the `render` event for that).
   */
  stats(): BoardStats {
    this.alive();
    const e = this.embedLayer;
    return {
      ...this.stage.stats(),
      embeds: {
        live: e.live.size,
        active: e.live.size - e.parked.size,
        maxLive: e.maxLive,
        parked: e.parked.size,
        culled: e.culled.size,
        frozen: e.frozen.size,
        animating: e.animating.size,
        animatingBudget: e.animatingBudget,
        loading: e.loading.size,
        previewsPending: e.previewsPending,
        freezeThreshold: e.freezeThreshold,
        interacting: e.interacting,
      },
      video: { playing: this.videoLayer.playing.size, budget: this.videoLayer.playingBudget },
    };
  }

  /**
   * The bounding box of a card on screen, as a {@link Box} in host-local CSS px (for HTML UI pinned to a card).
   *
   * @returns `undefined` when there is no such card.
   */
  screenRect(id: CardId): Box | undefined {
    this.alive();
    const el = this.store.get(id);
    if (!el) return undefined;
    const b = elementBox(el);
    const a = this.stage.worldToScreen(b.minX, b.minY);
    const k = this.stage.cam.scale;
    return { x: a.x, y: a.y, w: (b.maxX - b.minX) * k, h: (b.maxY - b.minY) * k };
  }

  /**
   * Tears the board down: events, DOM, workers, textures, the WebGL context. Idempotent. Every other method
   * throws a {@link CorkboardError} (`'disposed'`) afterwards, except `off` (a no-op) and the getters (`size`,
   * `selection`, `video.playing`...), which keep the last state.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.attempt(() => this.stage.dispose());
    this.emitter.clear();
  }

  private alive(): void {
    if (this.disposed) throw new CorkboardError('disposed', 'Corkboard: the board has been disposed');
  }

  // Lets go of everything but the stage and the emitter. Safe on a board the constructor did not finish:
  // a step that threw must not keep the others from running.
  private teardown(): void {
    this.attempt(() => this.input?.dispose());
    // A copy: a step may unregister itself (an overlay's disposer) while this runs.
    for (const f of this.cleanups.splice(0)) this.attempt(f);
    this.attempt(() => this.videoLayer?.dispose());
    this.attempt(() => this.embedLayer?.dispose());
    this.attempt(() => this.frameRate.dispose());
    this.attempt(() => this.overlayRoot?.remove());
  }

  private attempt(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error('[corkboard] dispose step failed', e);
    }
  }
}
