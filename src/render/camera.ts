// Board camera: pan, eased cursor-anchored zoom, drag inertia and animated fly-to. No DOM, no Pixi,
// no React: the stage feeds it input and calls `step(dt)` from its on-demand rAF loop.
//
// Friction, zoom ease and wheel normalisation are all integrated against the real frame `dt`, so the
// feel is identical at 60 and 120 Hz. The zoom range is 5 %..400 %.
import {
  clamp,
  visibleWorldRect,
  wheelZoomFactor,
  zoomAt,
  type Camera,
  type Rect,
} from '../math';
import { MAX_SCALE, MIN_SCALE } from '../types';

export { MAX_SCALE, MIN_SCALE };
// Fraction of the drag-release velocity KEPT per 1/60 s frame, and the speed under which it stops.
const FRICTION = 0.935;
const STOP_SPEED = 0.012; // px/ms
// Exponential zoom smoothing rate (1 - exp(-rate * dt)).
const ZOOM_EASE = 18;

export interface WheelInput {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  // ctrl / meta: a trackpad pinch (Chromium reports it as ctrl+wheel) or a mouse ctrl+wheel.
  zoom: boolean;
}

interface FlyTo {
  from: Camera;
  to: Camera;
  t: number;
  duration: number;
}

export class CameraController {
  readonly cam: Camera = { tx: 0, ty: 0, scale: 1 };
  // Bumped on every change of the camera, so consumers can skip untouched frames.
  version = 0;
  width = 0;
  height = 0;

  private targetScale = 1;
  private anchor = { x: 0, y: 0 };
  private vel = { vx: 0, vy: 0 };
  private dragging = false;
  private samples: { t: number; x: number; y: number }[] = [];
  private fly: FlyTo | null = null;
  private lastDrag: { x: number; y: number } | null = null;

  constructor(
    private readonly wake: () => void,
    private readonly bounds: { min: number; max: number } = { min: MIN_SCALE, max: MAX_SCALE },
  ) {}

  setViewport(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.version++;
  }

  get scale(): number {
    return this.cam.scale;
  }

  // True while an animation owns the camera (inertia, an eased zoom, a fly-to, a live drag).
  get busy(): boolean {
    return (
      this.dragging ||
      this.fly !== null ||
      Math.abs(this.vel.vx) > STOP_SPEED ||
      Math.abs(this.vel.vy) > STOP_SPEED ||
      this.cam.scale !== this.targetScale
    );
  }

  visibleRect(): Rect {
    return visibleWorldRect(this.cam, this.width, this.height);
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  wheel(e: WheelInput): void {
    this.fly = null;
    if (e.zoom) {
      this.targetScale = clamp(
        this.targetScale * wheelZoomFactor(e.deltaY, e.deltaMode),
        this.bounds.min,
        this.bounds.max,
      );
      this.anchor = { x: e.x, y: e.y };
    } else {
      // Plain wheel / two-finger swipe = pan; macOS already supplies the momentum.
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 800 : 1;
      this.cam.tx -= e.deltaX * k;
      this.cam.ty -= e.deltaY * k;
      this.version++;
    }
    this.wake();
  }

  dragStart(x: number, y: number, t: number): void {
    this.fly = null;
    this.dragging = true;
    this.vel.vx = 0;
    this.vel.vy = 0;
    this.lastDrag = { x, y };
    this.samples = [{ t, x, y }];
    this.wake();
  }

  dragMove(x: number, y: number, t: number): void {
    if (!this.dragging || !this.lastDrag) return;
    this.cam.tx += x - this.lastDrag.x;
    this.cam.ty += y - this.lastDrag.y;
    this.lastDrag = { x, y };
    this.version++;
    this.samples.push({ t, x, y });
    // Velocity comes from the trailing ~80 ms only, so a flick hands over a believable speed.
    while (this.samples.length > 2 && t - this.samples[0].t > 80) this.samples.shift();
    this.wake();
  }

  dragEnd(t: number): void {
    if (!this.dragging) return;
    this.dragging = false;
    const s = this.samples;
    const first = s[0];
    const last = s[s.length - 1];
    if (first && last && t - last.t < 60 && last.t > first.t) {
      this.vel.vx = (last.x - first.x) / (last.t - first.t);
      this.vel.vy = (last.y - first.y) / (last.t - first.t);
    }
    this.samples = [];
    this.lastDrag = null;
    this.wake();
  }

  // Immediate moves (scripted drivers: no easing, no inertia).
  panBy(dx: number, dy: number): void {
    this.cam.tx += dx;
    this.cam.ty += dy;
    this.version++;
  }

  // Multiplies the scale by `k` (clamped) keeping the world point under (ax, ay) still.
  zoomStep(k: number, ax: number, ay: number): void {
    const next = clamp(this.cam.scale * k, this.bounds.min, this.bounds.max);
    const z = zoomAt(this.cam, ax, ay, next);
    this.cam.tx = z.tx;
    this.cam.ty = z.ty;
    this.cam.scale = this.targetScale = z.scale;
    this.version++;
  }

  // Two-pointer pinch, incremental: `ratio` is the distance ratio since the last call and (dx, dy)
  // the midpoint's movement.
  pinch(ax: number, ay: number, ratio: number, dx: number, dy: number): void {
    this.fly = null;
    const next = clamp(this.cam.scale * ratio, this.bounds.min, this.bounds.max);
    const z = zoomAt(this.cam, ax, ay, next);
    this.cam.tx = z.tx + dx;
    this.cam.ty = z.ty + dy;
    this.cam.scale = z.scale;
    this.targetScale = z.scale;
    this.version++;
    this.wake();
  }

  // ── Programmatic moves ─────────────────────────────────────────────────────
  // Fits `world` in the viewport with `pad` screen px around it.
  fitCamera(world: Rect, pad = 48): Camera {
    const w = Math.max(1, world.x1 - world.x0);
    const h = Math.max(1, world.y1 - world.y0);
    const scale = clamp(
      Math.min((this.width - pad * 2) / w, (this.height - pad * 2) / h),
      this.bounds.min,
      this.bounds.max,
    );
    return {
      scale,
      tx: (this.width - w * scale) / 2 - world.x0 * scale,
      ty: (this.height - h * scale) / 2 - world.y0 * scale,
    };
  }

  jumpTo(c: Camera): void {
    this.fly = null;
    this.vel.vx = this.vel.vy = 0;
    this.cam.tx = c.tx;
    this.cam.ty = c.ty;
    this.cam.scale = this.targetScale = clamp(c.scale, this.bounds.min, this.bounds.max);
    this.version++;
    this.wake();
  }

  // Animated move (log-space on the scale so a long zoom feels even).
  flyTo(c: Camera, duration = 380): void {
    this.vel.vx = this.vel.vy = 0;
    this.targetScale = this.cam.scale;
    this.fly = {
      from: { ...this.cam },
      to: { ...c, scale: clamp(c.scale, this.bounds.min, this.bounds.max) },
      t: 0,
      duration,
    };
    this.wake();
  }

  // 100 % about the viewport centre.
  zoomToActual(duration = 280): void {
    const z = zoomAt(this.cam, this.width / 2, this.height / 2, 1);
    this.flyTo(z, duration);
  }

  // ── Per frame ──────────────────────────────────────────────────────────────
  // Advances inertia, the eased zoom and any fly-to by `dt` ms. Returns true while more frames are
  // needed.
  step(dt: number): boolean {
    const cam = this.cam;
    let busy = false;

    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.duration);
      const e = 1 - Math.pow(1 - f.t, 3); // ease-out cubic
      const s0 = Math.log(f.from.scale);
      const s1 = Math.log(f.to.scale);
      cam.scale = Math.exp(s0 + (s1 - s0) * e);
      // Interpolate the world point at the viewport centre, so pan and zoom stay coupled.
      const cx = this.width / 2;
      const cy = this.height / 2;
      const w0x = (cx - f.from.tx) / f.from.scale;
      const w0y = (cy - f.from.ty) / f.from.scale;
      const w1x = (cx - f.to.tx) / f.to.scale;
      const w1y = (cy - f.to.ty) / f.to.scale;
      const wx = w0x + (w1x - w0x) * e;
      const wy = w0y + (w1y - w0y) * e;
      cam.tx = cx - wx * cam.scale;
      cam.ty = cy - wy * cam.scale;
      this.targetScale = cam.scale;
      this.version++;
      if (f.t >= 1) this.fly = null;
      else busy = true;
      return busy;
    }

    const vel = this.vel;
    if (!this.dragging && (Math.abs(vel.vx) > STOP_SPEED || Math.abs(vel.vy) > STOP_SPEED)) {
      cam.tx += vel.vx * dt;
      cam.ty += vel.vy * dt;
      const decay = Math.pow(FRICTION, dt / (1000 / 60));
      vel.vx *= decay;
      vel.vy *= decay;
      this.version++;
      busy = true;
    } else if (!this.dragging) {
      vel.vx = 0;
      vel.vy = 0;
    }

    const target = this.targetScale;
    if (Math.abs(cam.scale - target) > 0.001 * target) {
      const a = 1 - Math.exp(-ZOOM_EASE * (dt / 1000));
      const next = zoomAt(cam, this.anchor.x, this.anchor.y, cam.scale + (target - cam.scale) * a);
      cam.tx = next.tx;
      cam.ty = next.ty;
      cam.scale = next.scale;
      this.version++;
      busy = true;
    } else if (cam.scale !== target) {
      // Final snap of the last sliver, still pinned to the anchor (a sub-pixel move).
      const next = zoomAt(cam, this.anchor.x, this.anchor.y, target);
      cam.tx = next.tx;
      cam.ty = next.ty;
      cam.scale = target;
      this.version++;
      busy = true;
    }
    return busy || this.dragging;
  }
}
