// Where a live iframe goes on screen. Pure maths, shared by the layer and its tests.
//
// Like the video overlay (src/video/videoGeometry.ts) the iframe is laid out ONCE at the card's world size
// and moved by `transform` alone, so the page inside re-rasterises at the camera's scale and stays sharp.
// A card wider than MAX_LAYOUT_PX is laid out smaller and scaled up, to bound the raster memory.
import type { Camera } from '../math';
import { videoPlacement, type VideoRect } from '../video/videoGeometry';

export const MAX_LAYOUT_PX = 2048;

export interface EmbedPlacement {
  // CSS px: the layout box of the iframe wrapper (world size, or less for a huge card).
  width: number;
  height: number;
  // CSS px relative to the overlay root: where the rotated top-left corner lands.
  x: number;
  y: number;
  // Where the box's centre lands.
  cx: number;
  cy: number;
  // The rotated top-right corner on screen (where the "Done" button hangs).
  topRightX: number;
  topRightY: number;
  transform: string;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

export function embedPlacement(r: VideoRect, camera: Camera): EmbedPlacement {
  const p = videoPlacement(r, camera);
  const f = Math.min(1, MAX_LAYOUT_PX / Math.max(r.w, r.h, 1));
  const scale = round6(camera.scale / f);
  const a = ((r.rot ?? 0) * Math.PI) / 180;
  // The top-right corner is `w` along the box's x axis from the top-left, on screen `w * k` long.
  const topRightX = round3(p.x + r.w * camera.scale * Math.cos(a));
  const topRightY = round3(p.y + r.w * camera.scale * Math.sin(a));
  return {
    width: round3(r.w * f),
    height: round3(r.h * f),
    x: p.x,
    y: p.y,
    cx: p.cx,
    cy: p.cy,
    topRightX,
    topRightY,
    transform:
      `translate(${p.x}px, ${p.y}px) scale(${scale})` + (p.rot === 0 ? '' : ` rotate(${p.rot}deg)`),
  };
}
