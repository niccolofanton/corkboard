// Where the video overlay's <video> goes on screen, from the card it covers: pure maths, no DOM, shared
// by the overlay and its tests.
//
// The <video> is laid out ONCE at the card's world size (`width` / `height` in world px, origin 0 0) and
// moved by `transform` alone: translate(rotated top-left on screen) scale(camera) rotate(card). A card
// rotates about the centre of its box, so its top-left corner is first rotated about that centre, in
// world space, to find where it lands; the element then rotates about that corner (its transform
// origin). The result covers exactly the rect the card's sprite draws, at any zoom, pan, rotation and
// device pixel ratio (the transform is CSS px, like the sprite).
import type { Camera } from '../math';
import { DEG } from '../interact/geometry';

export interface VideoRect {
  // World px: the card's box (x / y is the top-left of the UNROTATED box) and its rotation in degrees.
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
}

export interface VideoPlacement {
  // CSS px, relative to the overlay root: where the rotated top-left corner lands.
  x: number;
  y: number;
  // The camera's scale and the card's rotation in degrees (0 when it is not rotated).
  scale: number;
  rot: number;
  // Where the box's centre lands: what a badge on the card centres on.
  cx: number;
  cy: number;
  // The `transform` to write on the <video>.
  transform: string;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

export function videoPlacement(r: VideoRect, camera: Camera): VideoPlacement {
  const rot = r.rot ?? 0;
  const wcx = r.x + r.w / 2;
  const wcy = r.y + r.h / 2;
  let ox = r.x;
  let oy = r.y;
  if (rot !== 0) {
    const a = rot * DEG;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const dx = r.x - wcx;
    const dy = r.y - wcy;
    ox = wcx + dx * c - dy * s;
    oy = wcy + dx * s + dy * c;
  }
  const x = round3(camera.tx + ox * camera.scale);
  const y = round3(camera.ty + oy * camera.scale);
  const scale = round6(camera.scale);
  const rotR = round6(rot);
  return {
    x,
    y,
    scale,
    rot: rotR,
    cx: round3(camera.tx + wcx * camera.scale),
    cy: round3(camera.ty + wcy * camera.scale),
    transform:
      `translate(${x}px, ${y}px) scale(${scale})` + (rotR === 0 ? '' : ` rotate(${rotR}deg)`),
  };
}
