// Where a live iframe goes on screen. Pure maths, shared by the layer and its tests.
//
// Like the video overlay (src/video/videoGeometry.ts) the iframe is laid out ONCE and moved by `transform`
// alone, so the page inside re-rasterises at the camera's scale and stays sharp. The layout box is a virtual
// screen (`EmbedResolution`: 720p by default) with the card's aspect, so a page renders its desktop layout
// whatever the card's world size; 'native' lays it out at the world size instead. The long side never goes
// past MAX_LAYOUT_PX, to bound the raster memory (a very tall snippet is laid out smaller).
import type { Camera } from '../math';
import type { EmbedResolution } from '../types';
import { videoPlacement, type VideoRect } from '../video/videoGeometry';

export const MAX_LAYOUT_PX = 4096;
export const DEFAULT_RESOLUTION: EmbedResolution = '720p';

// The short side of the layout box in CSS px, or null for 'native' (the card's world size).
export function resolutionShortSide(res: EmbedResolution): number | null {
  if (res === 'native') return null;
  if (res === '720p') return 720;
  if (res === '1080p') return 1080;
  return Number.isFinite(res) && res > 0 ? res : 720;
}

export interface EmbedPlacement {
  // CSS px: the layout box of the iframe wrapper (the virtual screen, or the world size for 'native').
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

export function embedPlacement(
  r: VideoRect,
  camera: Camera,
  resolution: EmbedResolution = DEFAULT_RESOLUTION,
): EmbedPlacement {
  const p = videoPlacement(r, camera);
  // Layout px per world px.
  const short = resolutionShortSide(resolution);
  const want = short === null ? 1 : short / Math.max(Math.min(r.w, r.h), 1);
  const f = Math.min(want, MAX_LAYOUT_PX / Math.max(r.w, r.h, 1));
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
