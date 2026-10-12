// The video layer of a corkboard: wires the playing-video machinery (the hover / selection overlay, its
// controller and the always-playing pool) to the store and the stage.
//
//   mode 'always'  every video card in view plays on its own, muted and looping (the pool, ambient.ts);
//                  hover and selection still play a card with sound when `muted` is false
//   mode 'hover'   a hovered card plays after a short delay, a single selected card plays at once
//   mode 'off'     nothing plays: video cards are their poster
//
// A card plays only while it is on screen and at least MIN_SCREEN_PX wide (hover / selection) and the
// camera is not moving. The poster is the card's own texture, drawn by WebGL underneath the <video>.
import type { Store } from '../store';
import type { Stage } from '../render/stage';
import type { ElementId } from '../types';
import { AmbientVideos } from './ambient';
import type { AmbientCandidate } from './ambientPolicy';
import { VideoOverlay, type VideoTarget } from './video';
import { VideoController } from './videoController';

export type VideoMode = 'always' | 'hover' | 'off';

export interface VideoOptions {
  // Default 'always'.
  mode?: VideoMode;
  // Loop the videos (default true).
  loop?: boolean;
  // Mute the videos (default true). Only a hovered / selected card can play with sound, and only in a
  // page that has had a user gesture (autoplay policy).
  muted?: boolean;
  // `mode: 'always'`: a card plays on its own only if its long side is at least this many CSS px on screen
  // (default 160). Smaller ones stay a thumbnail.
  minPlayPx?: number;
  // `mode: 'always'`: at most this many cards play at once on a mouse / pen device (default 8) ...
  maxPlaying?: number;
  // ... and on a touch device (default 2). The biggest and most central cards win.
  maxPlayingTouch?: number;
}

export interface VideoLayerDeps {
  // The DOM layer the <video> elements go in (position: absolute, covering the canvas).
  root: HTMLElement;
  store: Store;
  stage: Stage;
}

export class VideoLayer {
  private readonly overlay: VideoOverlay;
  private readonly controller: VideoController;
  private readonly ambient: AmbientVideos;
  private readonly store: Store;
  private readonly stage: Stage;
  private mode: VideoMode = 'always';
  private loop = true;
  private muted = true;

  constructor(deps: VideoLayerDeps, options: VideoOptions = {}) {
    const { root, store, stage } = deps;
    this.store = store;
    this.stage = stage;
    this.overlay = new VideoOverlay(root);
    this.ambient = new AmbientVideos({
      root,
      camera: () => stage.cam.cam,
      viewport: () => ({ w: stage.cam.width, h: stage.cam.height }),
      candidates: () => this.candidates(),
      target: (id) => this.targetOf(id),
      // A card that got (or lost) its video, or moved: the store's changes.
      watch: (invalidate) =>
        store.subscribe((e) => {
          if (e.type === 'change') invalidate();
        }),
      // Which cards the pool plays decides whether the hover overlay has anything to add.
      onChange: () => this.controller.recheck(),
    });
    this.controller = new VideoController({
      show: (id) => {
        this.showOverlay(id);
        this.ambient.exclude(id);
      },
      hide: () => {
        this.overlay.hide();
        this.ambient.exclude(null);
      },
      // The hover delay: the ring's wait starts with the pointer, not when the file is first asked for.
      pending: (id) => (id === null ? this.overlay.hide() : this.showOverlay(id, false)),
      card: (id) => {
        const el = this.store.get(id);
        if (!el || !el.media.video) return null;
        return {
          id,
          hasVideo: true,
          screenWidth: el.w * stage.cam.scale,
          covered: this.ambient.covers(id),
        };
      },
    });
    this.setOptions(options);
  }

  setOptions(o: VideoOptions): void {
    const mode = o.mode ?? this.mode;
    this.mode = mode;
    this.loop = o.loop ?? this.loop;
    this.muted = o.muted ?? this.muted;
    this.overlay.setPlayback({ loop: this.loop, muted: this.muted });
    this.controller.setEnabled(mode !== 'off');
    this.ambient.setOptions({
      always: mode === 'always',
      loop: this.loop,
      muted: this.muted,
      minPlayPx: o.minPlayPx,
      maxPlaying: o.maxPlaying,
      maxPlayingTouch: o.maxPlayingTouch,
    });
  }

  get playing(): ReadonlySet<ElementId> {
    const ids = new Set<ElementId>(this.ambient.playingIds);
    const active = this.overlay.activeId;
    if (active !== null) ids.add(active);
    return ids;
  }

  // The pointer is over a video card (null: none).
  setHover(id: ElementId | null): void {
    this.controller.setHover(id);
  }

  setSelection(ids: readonly ElementId[]): void {
    this.controller.setSelection(ids);
  }

  // A finger has no hover and no selection playback.
  setTouch(touch: boolean): void {
    this.controller.setTouch(touch);
    this.ambient.setTouch(touch);
  }

  // Pauses every stream (a lightbox over the canvas, say).
  setPaused(paused: boolean): void {
    this.controller.setEnabled(!paused && this.mode !== 'off');
    this.ambient.setPaused(paused);
  }

  // Called by the stage on every frame, after the camera moved or not.
  onFrame(camChanged: boolean): void {
    const cam = this.stage.cam.cam;
    if (camChanged) {
      this.overlay.sync(cam);
      this.ambient.sync(cam);
      this.controller.setCameraMoving(true);
      this.controller.recheck();
    }
    this.follow();
    this.ambient.follow(cam);
  }

  // The camera has been still for a moment.
  onSettle(): void {
    this.ambient.settle();
    this.controller.setCameraMoving(false);
  }

  dispose(): void {
    this.controller.dispose();
    this.ambient.dispose();
    this.overlay.dispose();
  }

  // The playing overlay goes where its card is NOW, every frame: the live drag / resize preview, else
  // the store. A card that is gone, or shrank under the playback threshold, stops through the controller.
  private follow(): void {
    const id = this.overlay.activeId;
    if (id === null) return;
    const r = this.stage.previewRectOf(id) ?? this.store.get(id);
    if (!r) this.controller.recheck();
    else if (this.overlay.follow({ x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot }, this.stage.cam.cam)) {
      this.controller.recheck();
    }
  }

  private showOverlay(id: ElementId, load = true): void {
    const t = this.targetOf(id);
    if (t) this.overlay.show(t, this.stage.cam.cam, load);
  }

  private targetOf(id: ElementId): VideoTarget | null {
    const el = this.store.get(id);
    if (!el || !el.media.video) return null;
    // The live drag / resize preview, else the store's.
    const r = this.stage.previewRectOf(id) ?? el;
    return {
      id,
      src: el.media.video,
      box: { x: r.x, y: r.y, w: r.w, h: r.h },
      rot: r.rot,
      radius: el.radius,
    };
  }

  private *candidates(): IterableIterator<AmbientCandidate> {
    for (const el of this.store.elements()) {
      if (!el.media.video) continue;
      yield { id: el.id, x: el.x, y: el.y, w: el.w, h: el.h, rot: el.rot };
    }
  }
}
