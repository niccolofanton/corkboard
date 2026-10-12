// Decides which video card plays, and when, from the pointer / selection / camera state (`mode: 'hover'`).
// The side effects are injected (`show`, `hide`, timers), so the whole matrix runs under fake timers.
import {
  HOVER_DELAY_MS,
  wantedPlayback,
  type PlaybackWant,
  type VideoCardState,
} from './videoPolicy';

export { HOVER_DELAY_MS, MIN_SCREEN_PX } from './videoPolicy';
export type { VideoCardState } from './videoPolicy';

export interface VideoControllerDeps {
  show(id: string): void;
  hide(): void;
  // The pointer rests on a playable card and the hover delay is running: `id` (the card is asked for, so
  // the overlay can start its buffering clock now, not when the delay is over), or null when the hover
  // ended or the card stopped being playable before it played. `show` follows when the delay is over.
  pending?(id: string | null): void;
  // Re-read whenever a decision is made (and when the hover timer fires), never cached.
  card(id: string): VideoCardState | null;
  // Default to the globals, looked up at call time.
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class VideoController {
  private readonly deps: VideoControllerDeps;
  private selection: readonly string[] = [];
  private hoverId: string | null = null;
  private moving = false;
  private touch = false;
  private enabled = true;
  private hoverPlay = true;
  private playing: string | null = null;
  // The hover timer: the card it was armed for, and its handle.
  private timerFor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: VideoControllerDeps) {
    this.deps = deps;
  }

  get playingId(): string | null {
    return this.playing;
  }

  // Pointer over a card (or null when it left every card).
  setHover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.reconcile();
  }

  setSelection(ids: readonly string[]): void {
    // Copied: the caller's array may be a reused buffer.
    this.selection = ids.slice();
    this.reconcile();
  }

  setCameraMoving(moving: boolean): void {
    if (moving === this.moving) return;
    this.moving = moving;
    this.reconcile();
  }

  setTouch(touch: boolean): void {
    if (touch === this.touch) return;
    this.touch = touch;
    this.reconcile();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.reconcile();
  }

  setHoverPlay(on: boolean): void {
    if (on === this.hoverPlay) return;
    this.hoverPlay = on;
    this.reconcile();
  }

  // Card sizes changed (zoom) or a card gained / lost its video.
  recheck(): void {
    this.reconcile();
  }

  dispose(): void {
    this.clearTimer();
    this.stop();
  }

  private want(): PlaybackWant {
    return wantedPlayback({
      enabled: this.enabled,
      touch: this.touch,
      hoverPlay: this.hoverPlay,
      cameraMoving: this.moving,
      selection: this.selection,
      hoverId: this.hoverId,
      card: this.deps.card,
    });
  }

  private reconcile(): void {
    const want = this.want();
    if (want.immediate !== null) {
      this.clearTimer();
      this.start(want.immediate);
    } else if (want.delayed !== null) {
      const id = want.delayed;
      if (this.playing === id) {
        // Selection released while the pointer is still on it: keep playing.
        this.clearTimer();
        return;
      }
      // Another card was playing: it stops now, the new one waits for its delay.
      this.stop();
      if (this.timerFor !== id) this.armTimer(id);
    } else {
      this.clearTimer();
      this.stop();
    }
  }

  private start(id: string): void {
    if (this.playing === id) return;
    this.playing = id;
    this.deps.show(id);
  }

  private stop(): void {
    if (this.playing === null) return;
    this.playing = null;
    this.deps.hide();
  }

  private armTimer(id: string): void {
    this.clearTimer(false);
    this.timerFor = id;
    this.deps.pending?.(id);
    const set = this.deps.setTimer ?? setTimeout;
    this.timer = set(() => {
      this.timer = null;
      this.timerFor = null;
      // The card may have shrunk, lost its video or been unhovered during the delay: ask again.
      if (this.want().delayed === id) this.start(id);
      else {
        this.deps.pending?.(null);
        this.reconcile();
      }
    }, HOVER_DELAY_MS);
  }

  // `notify`: tell the deps the pending card is gone (false when another card takes its place at once).
  private clearTimer(notify = true): void {
    if (this.timer !== null) {
      const clear = this.deps.clearTimer ?? clearTimeout;
      clear(this.timer);
      this.timer = null;
      if (notify) this.deps.pending?.(null);
    }
    this.timerFor = null;
  }
}
