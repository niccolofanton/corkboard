// Pure camera math. No DOM, no Pixi.

/** The view: a world point (wx, wy) shows at (`tx` + wx * `scale`, `ty` + wy * `scale`) in host-local CSS px. */
export interface Camera {
  /** Screen x of the world origin, CSS px. */
  tx: number;
  /** Screen y of the world origin, CSS px. */
  ty: number;
  /** Zoom: CSS px per world px. */
  scale: number;
}

/**
 * A world rectangle by its corners: (`x0`, `y0`) top-left, (`x1`, `y1`) bottom-right. What `camera.visible()`,
 * `bounds()`, `inRect()` and `camera.zoomTo()` use. See {@link Box} for the `{ x, y, w, h }` shape.
 */
export interface Rect {
  /** Left edge. */
  x0: number;
  /** Top edge. */
  y0: number;
  /** Right edge. */
  x1: number;
  /** Bottom edge. */
  y1: number;
}

/**
 * An x/y/w/h rectangle: top-left corner and size. Each use says whether it is world px or screen px:
 * `board.screenRect(id)` returns one in host-local CSS px (where the card is drawn), the `rects` of the `transform`
 * event are in world px. Not to be confused with {@link Rect}, the world rectangle by corners.
 */
export interface Box {
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  /** Width. */
  w: number;
  /** Height. */
  h: number;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// Re-scales the camera to `scale` while the world point under the screen point (ax, ay) stays exactly
// where it is (cursor-anchored zoom).
export function zoomAt(cam: Camera, ax: number, ay: number, scale: number): Camera {
  const k = scale / cam.scale;
  return { tx: ax - (ax - cam.tx) * k, ty: ay - (ay - cam.ty) * k, scale };
}

// Wheel -> multiplicative zoom factor. Pixel-normalizes line/page deltas and caps one event's
// contribution, so a mouse ctrl+wheel notch (deltaY +-100, or +-3 lines) is one comfortable step instead
// of slamming the scale into its clamp, while a trackpad pinch (a stream of small deltas) stays
// proportional.
export const ZOOM_PER_PX = 0.012;
export const MAX_ZOOM_DELTA_PX = 20;
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY;
  return Math.exp(-clamp(px, -MAX_ZOOM_DELTA_PX, MAX_ZOOM_DELTA_PX) * ZOOM_PER_PX);
}

// The world rectangle a viewport of w x h screen px shows through `cam`.
export function visibleWorldRect(cam: Camera, w: number, h: number): Rect {
  return {
    x0: -cam.tx / cam.scale,
    y0: -cam.ty / cam.scale,
    x1: (w - cam.tx) / cam.scale,
    y1: (h - cam.ty) / cam.scale,
  };
}
