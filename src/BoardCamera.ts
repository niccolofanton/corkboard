// `board.camera` (typed as `CameraApi` in api.ts): moves and reads the stage's camera.
import type { CameraApi, CameraMoveOptions } from './api';
import { assertRect, idList, positive } from './check';
import { CorkboardError } from './errors';
import { assertRange, checkMoveOptions, checkPoint } from './options';
import type { Camera, Rect } from './math';
import type { Stage } from './render/stage';
import type { Store } from './store';
import type { CardId } from './types';

export class BoardCamera implements CameraApi {
  constructor(
    private readonly stage: Stage,
    private readonly store: Store,
    // Throws once the board is disposed (the board's own check; a standalone api never does).
    private readonly alive: () => void = () => {},
  ) {}

  get(): Camera {
    this.alive();
    return { ...this.stage.cam.cam };
  }

  set(c: Camera): void {
    this.alive();
    const ok = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
    if (typeof c !== 'object' || c === null || !ok(c.tx) || !ok(c.ty) || !ok(c.scale) || c.scale <= 0) {
      throw new CorkboardError(
        'invalid',
        'camera.set: needs { tx, ty } finite and { scale } finite and > 0 (got ' + JSON.stringify(c) + ')',
      );
    }
    this.stage.setCamera(c);
  }

  // The zoom range.
  setRange(min: number, max: number): void {
    this.alive();
    assertRange('camera.setRange', min, max);
    this.stage.setScaleRange(min, max);
  }

  // Fits the given cards (default: all) in the view. With nothing to fit (an empty board, or none of the
  // ids is a card) the camera stays where it is.
  fit(ids?: CardId | readonly CardId[], o: CameraMoveOptions = {}): void {
    this.alive();
    const list = idList('camera.fit', ids, true);
    const opts = checkMoveOptions('camera.fit', o);
    if (list ? !list.some((id) => this.store.has(id)) : this.store.size === 0) return;
    this.stage.fitRect(() => this.stage.boundsOf(list), opts.animate ?? true, opts.padding ?? 48);
  }

  // Fits a world rectangle in the view.
  zoomTo(r: Rect, o: CameraMoveOptions = {}): void {
    this.alive();
    assertRect('camera.zoomTo', r);
    const opts = checkMoveOptions('camera.zoomTo', o);
    this.stage.fitRect({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }, opts.animate ?? true, opts.padding ?? 48);
  }

  zoomBy(k: number): void {
    this.alive();
    positive('camera.zoomBy', 'k', k);
    this.stage.zoomBy(k);
  }

  // 100 % about the middle of the view.
  actual(): void {
    this.alive();
    this.stage.zoomToActual();
  }

  // Centres the view on a world point, optionally at a given zoom.
  center(x: number, y: number, scale?: number, o: CameraMoveOptions = {}): void {
    this.alive();
    checkPoint('camera.center', x, y);
    if (scale !== undefined) positive('camera.center', 'scale', scale);
    const opts = checkMoveOptions('camera.center', o);
    const s = scale ?? this.stage.cam.scale;
    const c: Camera = {
      scale: s,
      tx: this.stage.cam.width / 2 - x * s,
      ty: this.stage.cam.height / 2 - y * s,
    };
    if (opts.animate ?? true) this.stage.cam.flyTo(c);
    else this.stage.setCamera(c);
  }

  // The world rectangle in view.
  visible(): Rect {
    this.alive();
    return this.stage.cam.visibleRect();
  }

  screenToWorld(x: number, y: number): { x: number; y: number } {
    this.alive();
    checkPoint('camera.screenToWorld', x, y);
    return this.stage.screenToWorld(x, y);
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    this.alive();
    checkPoint('camera.worldToScreen', x, y);
    return this.stage.worldToScreen(x, y);
  }
}
