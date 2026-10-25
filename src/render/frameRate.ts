// FrameRateMonitor: measures how fast the page really renders, shared by everything that sheds load when it
// does not keep up (the embed layer's animating budget and freezing, the ambient video pool).
//
// A rAF loop that never stops keeps the page awake for nothing, so it samples in BURSTS: one is started (or
// extended) by `poke()`, which the consumers call on any event that can change the load (the camera settled,
// frames mounted / destroyed / frozen, a budget moved, the video pool changed), and again by a heartbeat every
// HEARTBEAT_MS while any consumer has something rendering. A burst ends after BURST_WINDOWS windows, or as soon
// as AGREE_WINDOWS in a row say the same (slow, smooth or neither): the reading is stable and the loop stops.
// A poke inside a burst starts its count over, so a consumer that keeps changing things keeps being measured.
//
// fps is read over windows of SAMPLE_WINDOW_MS. The first window of a burst started by an event does not count
// (it sees frames mounting), nor does one that follows a stall (a hidden page). A window is `slow` under
// SLOW_FPS and `smooth` over SMOOTH_FPS; both are for a 60 Hz display and scale down with the fastest window
// seen, so a 30 Hz (low power) screen is judged against its own rate.

export const SAMPLE_WINDOW_MS = 1000;
export const SLOW_FPS = 40;
export const SMOOTH_FPS = 55;
/** Windows in a row over SMOOTH_FPS that consumers take as "room to give something back". */
export const SMOOTH_WINDOWS = 2;
const REFERENCE_HZ = 60;
// A gap between two frames this long is a hidden or occluded page, not a slow one: the window is dropped.
const STALL_MS = 2500;
/** A burst: at most this many counted windows, or until this many in a row agree. */
export const BURST_WINDOWS = 4;
export const AGREE_WINDOWS = 2;
/** While anything renders, a burst starts at least this often even if nothing happened. */
export const HEARTBEAT_MS = 10_000;

/** One window of frame-time samples from the frame-rate monitor. */
export interface FrameWindow {
  fps: number;
  // Under SLOW_FPS (scaled to the display).
  slow: boolean;
  // Over SMOOTH_FPS (scaled to the display).
  smooth: boolean;
}

/** What the frame-rate monitor needs from its environment (a seam for tests). */
export interface FrameRateDeps {
  // The frame scheduler (default: the window's). A seam for tests; the callback gets the frame's timestamp,
  // which is the only clock the monitor reads.
  raf?: (cb: (time: number) => void) => number;
  caf?: (id: number) => void;
  // For the page's visibility (a hidden tab does not paint: nothing is measured). Default: the global one.
  doc?: Document;
  burstWindows?: number;
  agreeWindows?: number;
  heartbeatMs?: number;
}

interface Run {
  id: number;
  // Timestamp of the window's start and of the last frame (NaN: no frame yet), and frames since the start.
  start: number;
  last: number;
  frames: number;
  // The window in progress does not count.
  discard: boolean;
  // Frame intervals of the window in progress: their fast end is the display's refresh rate.
  deltas: number[];
}

/** Measures the page's frame rate in short bursts, for the layers that shed load when it is slow. */
export class FrameRateMonitor {
  private readonly rafFn: ((cb: (time: number) => void) => number) | undefined;
  private readonly cafFn: ((id: number) => void) | undefined;
  private readonly doc: Document | undefined;
  private readonly burstWindows: number;
  private readonly agreeWindows: number;
  private readonly heartbeatMs: number;
  private run: Run | null = null;
  private readonly loads = new Set<() => boolean>();
  private readonly windowFns = new Set<(w: FrameWindow) => void>();
  private readonly startFns = new Set<() => void>();
  // Counted windows of the burst, and how many in a row had the same verdict.
  private counted = 0;
  private streak = 0;
  private verdict: 'slow' | 'smooth' | 'mid' | null = null;
  private beat: ReturnType<typeof setTimeout> | null = null;
  private peakFps = 0;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(deps: FrameRateDeps = {}) {
    const doc = deps.doc ?? (typeof document !== 'undefined' ? document : undefined);
    const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
    this.doc = doc;
    this.rafFn = deps.raf ?? (win ? (cb) => win.requestAnimationFrame(cb) : undefined);
    this.cafFn = deps.caf ?? (win ? (id) => win.cancelAnimationFrame(id) : undefined);
    this.burstWindows = deps.burstWindows ?? BURST_WINDOWS;
    this.agreeWindows = deps.agreeWindows ?? AGREE_WINDOWS;
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
    if (doc) {
      // A hidden tab stops the burst; back, a fresh one measures from scratch.
      const onVisibility = (): void => this.poke();
      doc.addEventListener('visibilitychange', onVisibility);
      this.cleanups.push(() => doc.removeEventListener('visibilitychange', onVisibility));
    }
  }

  // A burst is sampling now.
  get running(): boolean {
    return this.run !== null;
  }

  // The fastest the display has shown it can go (fps; 0: not known yet).
  get peak(): number {
    return this.peakFps;
  }

  // A consumer says whether it has anything rendering that load could slow down. Bursts (and the heartbeat)
  // only run while at least one does. Returns the unsubscribe.
  load(fn: () => boolean): () => void {
    this.loads.add(fn);
    return () => {
      this.loads.delete(fn);
    };
  }

  // Called once per counted window. Returns the unsubscribe.
  onWindow(fn: (w: FrameWindow) => void): () => void {
    this.windowFns.add(fn);
    return () => {
      this.windowFns.delete(fn);
    };
  }

  // Called when a burst starts afresh: windows before it are no "in a row" with the ones to come.
  onStart(fn: () => void): () => void {
    this.startFns.add(fn);
    return () => {
      this.startFns.delete(fn);
    };
  }

  // Something that can change the load happened (or may have: a consumer's load can also have gone). Starts a
  // burst, or extends the one running; stops one that has nothing left to measure.
  poke(): void {
    if (this.disposed) return;
    if (!this.canRun()) {
      this.stop();
      this.clearBeat();
      return;
    }
    if (this.run) {
      this.counted = 0;
      this.streak = 0;
      this.verdict = null;
    } else this.start(true);
    this.armBeat();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.clearBeat();
    for (const f of this.cleanups) f();
    this.loads.clear();
    this.windowFns.clear();
    this.startFns.clear();
  }

  private canRun(): boolean {
    if (!this.rafFn || this.doc?.visibilityState === 'hidden') return false;
    for (const l of this.loads) if (l()) return true;
    return false;
  }

  // The heartbeat: a burst even if nothing happened, while something renders.
  private armBeat(): void {
    if (this.beat !== null || !Number.isFinite(this.heartbeatMs)) return;
    this.beat = setTimeout(() => {
      this.beat = null;
      if (this.disposed) return;
      if (!this.canRun()) return this.stop();
      // Nothing is mounting: the first window is as good as the rest.
      if (!this.run) this.start(false);
      this.armBeat();
    }, this.heartbeatMs);
  }

  private clearBeat(): void {
    if (this.beat !== null) clearTimeout(this.beat);
    this.beat = null;
  }

  private start(discardFirst: boolean): void {
    const raf = this.rafFn;
    if (!raf) return;
    const s: Run = { id: 0, start: Number.NaN, last: Number.NaN, frames: 0, discard: discardFirst, deltas: [] };
    this.run = s;
    this.counted = 0;
    this.streak = 0;
    this.verdict = null;
    for (const f of [...this.startFns]) f();
    const tick = (ts: number): void => {
      if (this.run !== s) return;
      if (Number.isNaN(s.start) || ts - s.last > STALL_MS) {
        // A stall saw nothing: that window is dropped, and so is the one in progress after it.
        if (!Number.isNaN(s.start)) s.discard = true;
        s.start = ts;
        s.frames = 0;
        s.deltas.length = 0;
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
          if (!skip) this.window(fps);
        }
      }
      s.last = ts;
      // A consumer may have stopped it.
      if (this.run === s) s.id = raf(tick);
    };
    s.id = raf(tick);
  }

  private stop(): void {
    const s = this.run;
    if (!s) return;
    this.run = null;
    this.cafFn?.(s.id);
  }

  private window(fps: number): void {
    // A slower display (30 Hz low power) lowers the bar; a faster one does not raise it: 40 fps on a 120 Hz
    // screen is still slow, and 60 is smooth enough to give frames back.
    const k = Math.min(1, (this.peakFps > 0 ? this.peakFps : REFERENCE_HZ) / REFERENCE_HZ);
    const w: FrameWindow = { fps, slow: fps < SLOW_FPS * k, smooth: fps > SMOOTH_FPS * k };
    const verdict = w.slow ? 'slow' : w.smooth ? 'smooth' : 'mid';
    this.counted++;
    this.streak = verdict === this.verdict ? this.streak + 1 : 1;
    this.verdict = verdict;
    // A consumer that changes something pokes: the count starts over and the burst goes on.
    for (const f of [...this.windowFns]) f(w);
    if (this.run && (this.counted >= this.burstWindows || this.streak >= this.agreeWindows)) this.stop();
  }
}

// The refresh rate a window's frame intervals show (0: too few to tell), at most 240 Hz.
function refreshOf(deltas: readonly number[]): number {
  if (deltas.length < 10) return 0;
  const d = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length * 0.1)];
  return d > 0 ? Math.min(240, 1000 / d) : 0;
}
