// The shape of `board.stats()`: counters and timings of the render loop, the texture pipeline, the embeds
// and the videos. Pure types: no Pixi, no DOM.
import type { CardId } from './types';

/** The spread of a series of timings, in ms. */
export interface Percentiles {
  /** How many samples (the stage keeps the latest 4096 per series). */
  n: number;
  /** Median. */
  p50: number;
  /** 95th percentile. */
  p95: number;
  /** The slowest sample. */
  max: number;
}

/** A tick that took over 25 ms, with where the time went. */
export interface SlowTick {
  /** The whole tick. */
  ms: number;
  /** The camera zoom when it happened. */
  scale: number;
  /** Views mounted at the time. */
  mounted: number;
  /** Views mounted so far (cumulative). */
  mounts: number;
  /** The phases of the tick, ms: syncing the store... */
  store: number;
  /** ...the camera step... */
  camera: number;
  /** ...texture uploads... */
  upload: number;
  /** ...the DOM layers... */
  overlay: number;
  /** ...and the render call. */
  render: number;
}

/** Texture memory and the decode / upload pipeline. */
export interface TextureStats {
  /** GPU bytes held by the pipeline now. */
  bytes: number;
  /** The budget it keeps under (`textures.budgetBytes`). */
  budget: number;
  /** The most it has held since the start (or the last reset). */
  peakBytes: number;
  /** The longest it stayed over budget, ms. */
  overBudgetMsMax: number;
  /** Mounted cards by the level their texture is at: `[L0, L1, L2, L3]` (placeholder, atlas cell, own texture, close zoom). */
  levelsMounted: [number, number, number, number];
  /** Atlas pages: placeholders (L0) and pictures (L1). */
  pages: { l0: number; l1: number };
  /** Cards that own a texture at the medium / large level. */
  l2: number;
  /** Same, at the close-zoom level. */
  l3: number;
  /** Textures evicted and waiting for the next render to be destroyed. */
  retiredPending: number;
  /** Where the bytes are. `pinned*` is the share of the own textures that is on screen (cannot be evicted). */
  breakdown: { pageBytes: number; l2Bytes: number; l3Bytes: number; pinnedBytes: number; pinned: number };
  /** Decodes waiting for a worker / running. */
  queued: number;
  /** Decodes running in the workers. */
  inflight: number;
  /** Finished decodes, and their mean time, ms. */
  decodes: number;
  /** Mean decode time, ms. */
  decodeMsAvg: number;
  /** Bytes the workers fetched. */
  fetchedBytes: number;
  /** Decodes cancelled before they finished. */
  cancelled: number;
  /** Decodes that failed. */
  failed: number;
  /** Textures dropped to stay in budget, by level. */
  evicted: { l1: number; l2: number; l3: number };
  /** Textures uploaded to the GPU. */
  uploads: number;
  /** Upload time per frame: the worst and the mean, ms. */
  uploadMsMax: number;
  uploadMsAvg: number;
  /** Uploads done in the last rendered frame. */
  uploadsLastFrame: number;
}

/** The render loop. Timings are in ms; a series with no sample yet is `null`. */
export interface RenderStats {
  /** Frames rendered (idle ticks do not count). */
  frames: number;
  /** `requestAnimationFrame` callbacks asked for: it stops growing when the board is idle. */
  rafCalls: number;
  /** Ticks run, idle ones included. */
  ticks: number;
  /** Time of the whole tick (store sync, culling, uploads, render). */
  tickMs: Percentiles | null;
  /** Main-thread time of the render call. */
  cpuMs: Percentiles | null;
  /** GPU time per render (`gpuTimer: true` and a browser with `EXT_disjoint_timer_query_webgl2`). */
  gpuMs: Percentiles | null;
  /** Why `gpuMs` is `null`: the option is off, the browser has no timer, or no result came back yet. */
  gpuTimer: 'off' | 'unsupported' | 'on';
  /** Frames that threw and were healed by rebuilding the textures: since the last reset, and since the start. */
  renderErrors: number;
  /** Same, since the start. */
  renderErrorsTotal: number;
  /** Callbacks (yours or a layer's) that threw in a frame. */
  hookErrors: number;
  /** From the stage's start to the first painted frame / until every visible card had its picture, ms. */
  firstPaintMs: number | null;
  /** See `firstPaintMs`: until every visible card had its picture. */
  l1CompleteMs: number | null;
}

/**
 * @experimental Internals for profiling the stage (`board.stats().debug`). Not a stable surface: fields may
 * change in any release. Exported from `@niccolofanton/corkboard/unstable` only.
 */
export interface DebugStats {
  /** Culling passes run. */
  cullPasses: number;
  /** Spatial queries run. */
  requeries: number;
  /** Level-of-detail passes run. */
  lodPasses: number;
  /** Views mounted / unmounted since the start. */
  mounts: number;
  unmounts: number;
  /** The latest ticks over 25 ms. */
  slowTicks: SlowTick[];
  /** Cumulative time of the spatial query, mounting, unmounting and the LOD pass, ms. */
  requeryMs: { search: number; mount: number; unmount: number; lod: number };
  /** Time of the LOD pass, ms. */
  lodPassMs: Percentiles | null;
  /** Children of the Pixi world container. */
  worldChildren: number;
  /** The view pool: views created, taken back from it, and waiting in it. */
  viewPool: { created: number; reused: number; pooled: number };
  /** The GPU as the browser names it. */
  glRenderer: string;
}

/** What the stage reports (`Stage.stats()`). */
export interface StageStats {
  /** Cards the stage knows. */
  cards: number;
  /** Cards that have a view now (the rest are culled). */
  mounted: number;
  /** Views waiting for their mount slot. */
  mountQueue: number;
  /** The WebGL context is lost: nothing is drawn until it is restored. */
  lost: boolean;
  /** The camera zoom, the device pixel ratio and the host's size in CSS px. */
  scale: number;
  dpr: number;
  viewport: [number, number];
  /** Texture memory and the decode pipeline. */
  textures: TextureStats;
  /** The render loop. */
  render: RenderStats;
  /**
   * @experimental Profiling internals: fields may change in any release. The type is `DebugStats` from
   * `@niccolofanton/corkboard/unstable`.
   */
  debug: DebugStats;
}

/** The live iframes of the `embed` cards. Counts, except where noted. */
export interface EmbedStats {
  /** Mounted iframes now, active and parked. */
  live: number;
  /** Of those: active, rendering and interactive. This is the count `maxLive` caps. */
  active: number;
  /** The cap on `active` now (`embeds.maxLive`, or `maxLiveTouch` on a touch device; can be `Infinity`). */
  maxLive: number;
  /** Of the mounted ones: parked, mounted but inert, showing their last frame (`live - active`). */
  parked: number;
  /** ... off screen: hidden and not rendering. */
  culled: number;
  /** ... replaced by a snapshot. */
  frozen: number;
  /** ... allowed to animate, and how many may now (lowered while the page runs slow; can be `Infinity`). */
  animating: number;
  animatingBudget: number;
  /** ... whose page is still loading. */
  loading: number;
  /** Snippet previews not done yet (waiting, in the cache lookup, being rendered). */
  previewsPending: number;
  /** The short side (CSS px) under which a snippet freezes now (raised while the page stays slow). */
  freezeThreshold: number;
  /** The card in interact mode (null: none). */
  interacting: CardId | null;
}

/** Playing videos. */
export interface VideoStats {
  /** Clips playing now. */
  playing: number;
  /** How many the always-playing pool may run now (`video.maxPlaying`, lowered while the page runs slow; can be `Infinity`). */
  budget: number;
}

/** What `board.stats()` returns: a snapshot, safe to keep. */
export interface BoardStats extends StageStats {
  /** The live iframes of the embed cards. */
  embeds: EmbedStats;
  /** Playing videos. */
  video: VideoStats;
}
