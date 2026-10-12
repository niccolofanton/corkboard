// Pure camera math. No DOM, no Pixi.

// World -> screen camera: a world point (wx, wy) shows at (tx + wx*scale, ty + wy*scale).
export interface Camera {
  tx: number;
  ty: number;
  scale: number;
}

// A world rectangle by its corners.
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
