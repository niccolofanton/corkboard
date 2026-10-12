// `mode: 'always'`: the video cards that are in view play on their own, muted. A small pool of
// VideoOverlay elements, one per playing card, each laid over its card exactly like the hover overlay
// (video.ts: the card's thumbnail is the poster, the <video> fades in over it once a frame is up).
// With `mode: 'hover'` this pool stays off and VideoController drives a single overlay instead: hover
// plays a card after HOVER_DELAY_MS, a single selected card plays at once.
//
// Rules (a <video> is a decoder, and a canvas may hold hundreds of video cards):
//   - EVERY card that touches the viewport plays, at any zoom (ambientPolicy.ts): no size threshold and
//     no cap on what is on screen. The cards past the viewport's margin have no element at all, so nothing
//     is fetched or decoded for them: their thumbnail is all there is. A safety ceiling
//     (`AMBIENT_MAX_STREAMS`) guards against a runaway canvas.
//   - A card that leaves the set is paused and its file let go of; its element is reused by the next
//     card (a pan creates no elements once the pool has grown to the screen). The set is re-planned when
//     the camera settles and, throttled, while it moves, so a card scrolling in starts a moment before
//     it shows.
//   - New cards start a handful at a time, a few frames apart, not all in the same tick; the ones that
//     show the most start first.
//   - Nothing plays with `prefers-reduced-motion` or data saver on; a background tab pauses the clocks
//     (the elements stay), and `setPaused` (e.g. a full-screen viewer open over the canvas) lets go of every stream.
//   - The elements are muted + playsinline (the only kind a phone starts without a gesture).
// A card the hover overlay plays WITH sound (the pool is muted, the overlay is not) is excluded from the pool
// while it does (`exclude`), so one card is never two streams.
import type { Camera } from '../math';
import { VideoOverlay, type VideoTarget } from './video';
import {
  ambientAllowed,
  browserAmbientEnv,
  planAmbient,
  type AmbientCandidate,
  type AmbientEnv,
} from './ambientPolicy';
import type { VideoRect } from './videoGeometry';

// The plan is recomputed at most this often while the camera moves (and once it settles).
export const REPLAN_THROTTLE_MS = 150;
// New streams per pass, and the pause between passes (about three frames): a screenful of videos does
// not open all its connections in one tick, and still all of them are up in well under a second.
export const STARTS_PER_PASS = 6;
export const START_SPACING_MS = 50;
// Elements kept (empty) for the next card; past this they are let go of for good.
export const MAX_IDLE = 16;

export interface AmbientDeps {
  // The overlay layer the elements go in.
  root: HTMLElement;
  camera(): Camera;
  viewport(): { w: number; h: number };
  // Every video card, with its box (cheap: called on every plan).
  candidates(): Iterable<AmbientCandidate>;
  // A card's target as it is NOW (the live drag / resize preview, else the store's), null when it is
  // gone or has no video. Called for the cards that play, every frame (`follow`) or when they start.
  target(id: string): VideoTarget | null;
  // Subscribes `invalidate` to whatever changes the plan (cards moved, added, got their video).
  // Returns the unsubscribe.
  watch?(invalidate: () => void): () => void;
  // The set of playing cards changed (the hover overlay may now be redundant, or not).
  onChange?(): void;
  env?: AmbientEnv;
  // An extra reduced-motion switch (the OS one is read from `env`).
  reducedMotion?(): boolean;
  // Default to the globals, looked up at call time.
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?(): number;
}

export class AmbientVideos {
  private readonly deps: AmbientDeps;
  private readonly env: AmbientEnv;
  // Playing cards -> their element.
  private readonly active = new Map<string, VideoOverlay>();
  // The elements live in this layer, which carries the camera: panning or zooming is ONE transform for
  // the whole screenful (a transform per video, 40 times a frame, is what stalls the compositor), and a
  // video's own style is written only when its card moves.
  private readonly world: HTMLElement;
  private wroteWorld = '';
  // Elements not on a card (kept to reuse; at most MAX_IDLE).
  private readonly idle: VideoOverlay[] = [];
  private on = false;
  private loop = true;
  // The sound switch: when muted the pool fully covers a card, so the hover overlay stays out.
  private soundMuted = true;
  private paused = false;
  private suspended = false;
  private excluded: string | null = null;
  private lastPlan = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(deps: AmbientDeps) {
    this.deps = deps;
    this.env = deps.env ?? browserAmbientEnv;
    this.suspended = this.env.hidden();
    const world = deps.root.ownerDocument.createElement('div');
    world.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;pointer-events:none;';
    deps.root.append(world);
    this.world = world;
    this.writeWorld(deps.camera());
    if (deps.watch) this.cleanups.push(deps.watch(() => this.schedule()));
    if (typeof document !== 'undefined') {
      const onVisibility = (): void => this.setSuspended(this.env.hidden());
      document.addEventListener('visibilitychange', onVisibility);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
    // The OS switch can change while the canvas is open.
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      const fn = (): void => this.replan();
      mq.addEventListener?.('change', fn);
      this.cleanups.push(() => mq.removeEventListener?.('change', fn));
    }
  }

  // The ids that play now.
  get playingIds(): ReadonlySet<string> {
    return new Set(this.active.keys());
  }

  isPlaying(id: string): boolean {
    return this.active.has(id);
  }

  // The hover / selection overlay has nothing to add to this card: it plays here, muted, and the sound
  // switch is off.
  covers(id: string): boolean {
    return this.soundMuted && this.active.has(id);
  }

  // The switches: `always` turns the pool on, `loop` and `muted` are the playback options (the pool's own elements are muted whatever `muted` says: it only tells whether the hover overlay is
  // redundant).
  setOptions(o: { always: boolean; loop: boolean; muted: boolean }): void {
    if (this.disposed) return;
    const loopChanged = o.loop !== this.loop;
    this.loop = o.loop;
    this.soundMuted = o.muted;
    this.on = o.always;
    if (loopChanged) for (const v of [...this.active.values(), ...this.idle]) this.configure(v);
    this.replan();
  }

  // Something covers the canvas (a full-screen viewer): every stream is let go of until it closes.
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.replan();
  }

  // The card the hover overlay plays with sound (null: none). The pool lets go of it meanwhile.
  exclude(id: string | null): void {
    if (id === this.excluded) return;
    this.excluded = id;
    this.replan();
  }

  // The camera moved: the elements go with it (a transform each), and the plan is refreshed, throttled.
  sync(camera: Camera): void {
    if (this.disposed) return;
    // Every element, the ones still fading out (a card that left the set) included, is in this layer.
    this.writeWorld(camera);
    this.schedule();
  }

  // Every frame: each playing element goes where its card is now. A card that is gone, or resized, makes
  // the pool re-plan.
  follow(camera: Camera): void {
    if (this.disposed || this.active.size === 0) return;
    let stale = false;
    for (const [id, v] of this.active) {
      const t = this.deps.target(id);
      if (!t) {
        stale = true;
        continue;
      }
      const rect: VideoRect = { ...t.box, rot: t.rot };
      if (v.follow(rect, camera)) stale = true;
    }
    if (stale) this.schedule();
  }

  // Something that decides the plan changed (a card moved, appeared, got its video): refresh, throttled.
  invalidate(): void {
    this.schedule();
  }

  // The camera settled: refresh now.
  settle(): void {
    this.replan();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    for (const f of this.cleanups) f();
    for (const v of [...this.active.values(), ...this.idle]) v.dispose();
    this.active.clear();
    this.idle.length = 0;
    this.world.remove();
  }

  private writeWorld(cam: Camera): void {
    const t = `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.scale})`;
    if (t === this.wroteWorld) return;
    this.wroteWorld = t;
    this.world.style.transform = t;
  }

  private canPlay(): boolean {
    return this.on && !this.paused && !this.disposed && ambientAllowed(this.env) && !this.reduced();
  }

  private reduced(): boolean {
    return this.deps.reducedMotion?.() === true;
  }

  private setSuspended(hidden: boolean): void {
    if (hidden === this.suspended || this.disposed) return;
    this.suspended = hidden;
    if (hidden) {
      for (const v of this.active.values()) v.suspend();
    } else {
      for (const v of this.active.values()) v.resume();
      this.replan();
    }
  }

  private configure(v: VideoOverlay): void {
    // Always muted: the pool never makes noise.
    v.setPlayback({ loop: this.loop, muted: true });
  }

  private schedule(): void {
    if (this.disposed || this.timer !== null) return;
    // Switched off and nothing left to let go of: changes to the cards cost nothing here.
    if (!this.on && this.active.size === 0) return;
    const set = this.deps.setTimer ?? setTimeout;
    const now = (this.deps.now ?? Date.now)();
    const wait = Math.max(0, this.lastPlan + REPLAN_THROTTLE_MS - now);
    this.timer = set(() => {
      this.timer = null;
      this.replan();
    }, wait);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  // Brings the playing set to what the plan wants: let go of the cards that left, start (a few at a time)
  // the ones that came in.
  private replan(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.lastPlan = (this.deps.now ?? Date.now)();
    let changed = false;
    // The cards to play with their targets (a card that has no target any more is not one).
    const want: [string, VideoTarget][] = [];
    if (this.canPlay()) {
      const cards = [...this.deps.candidates()].filter((c) => c.id !== this.excluded);
      const ids = planAmbient({
        cards,
        camera: this.deps.camera(),
        viewport: this.deps.viewport(),
        playing: new Set(this.active.keys()),
      });
      for (const id of ids) {
        const t = this.deps.target(id);
        if (t) want.push([id, t]);
      }
    }
    const wanted = new Set(want.map(([id]) => id));
    for (const [id, v] of this.active) {
      if (wanted.has(id)) continue;
      v.hide();
      this.active.delete(id);
      this.idle.push(v);
      changed = true;
    }
    let starts = 0;
    let more = false;
    for (const [id, t] of want) {
      const have = this.active.get(id);
      if (have) {
        // Same card, new file (the card's video was replaced): start it over.
        if (have.activeSrc !== null && have.activeSrc !== t.src) have.show(t, this.deps.camera());
        continue;
      }
      if (starts >= STARTS_PER_PASS) {
        more = true;
        continue;
      }
      const v = this.take();
      this.active.set(id, v);
      this.writeWorld(this.deps.camera());
      v.show(t, this.deps.camera());
      if (this.suspended) v.suspend();
      starts++;
      changed = true;
    }
    // Spare elements past what the next pan needs go for good.
    while (this.idle.length > MAX_IDLE) this.idle.shift()?.dispose();
    if (more) {
      const set = this.deps.setTimer ?? setTimeout;
      this.timer = set(() => {
        this.timer = null;
        this.replan();
      }, START_SPACING_MS);
    }
    if (changed) this.deps.onChange?.();
  }

  // An element for a new card: one that is free, else a new one.
  private take(): VideoOverlay {
    const idle = this.idle.pop();
    if (idle) return idle;
    const v = new VideoOverlay(this.world, {
      spinner: false,
      worldSpace: true,
    });
    this.configure(v);
    return v;
  }
}
