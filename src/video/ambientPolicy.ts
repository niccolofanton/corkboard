// Which video cards play on their own in `mode: 'always'` (ambient.ts)? Pure rules shared by the pool
// and its tests. No DOM, no timers.
//
// A card plays only when it is worth a stream: it touches the viewport (plus a margin, so a card scrolling
// in is already moving) AND it is big enough on screen (`minPlayPx`, on its long side: a 20 px card at 10 %
// zoom shows nothing a thumbnail does not). Of those, at most `cap` play at once (8 on a mouse device, 2 on
// touch): a <video> is a decoder and a socket, and a screenful of them is what stalls a laptop. The biggest
// and most central win. A card that stays in the set keeps its stream; one that leaves is let go of.
import type { Camera } from '../math';
import { DEG } from '../interact/geometry';

// Streams that may run at once, whatever the options say: a ceiling against a runaway `maxPlaying`.
export const AMBIENT_MAX_STREAMS = 96;
// Defaults of `video.maxPlaying` / `video.maxPlayingTouch` and `video.minPlayPx`.
export const AMBIENT_MAX_PLAYING = 8;
export const AMBIENT_MAX_PLAYING_TOUCH = 2;
export const AMBIENT_MIN_PLAY_PX = 160;
// How far past the viewport (fraction of its size, each side) a card still plays.
export const AMBIENT_MARGIN = 0.25;
// Over the ceiling, a card that already plays keeps its seat unless another is clearly better: two
// near-equal cards must not swap on every pan.
const KEEP_BONUS = 1.25;

export interface AmbientCandidate {
  id: string;
  // World px: the card's box (x / y is the top-left of the UNROTATED box) and its rotation in degrees.
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
}

export interface AmbientPlanInput {
  cards: Iterable<AmbientCandidate>;
  camera: Camera;
  viewport: { w: number; h: number };
  // At most this many ids (default `AMBIENT_MAX_PLAYING`, never past `AMBIENT_MAX_STREAMS`).
  cap?: number;
  // A card plays only if its long side is at least this many CSS px on screen (default
  // `AMBIENT_MIN_PLAY_PX`; 0 = any size).
  minPlayPx?: number;
  // Ids that play now (they keep their seat on a near tie).
  playing?: ReadonlySet<string>;
  margin?: number;
}

interface ScreenBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// The axis-aligned box on screen of a card (rotation included: the box of its four corners).
function screenBox(c: AmbientCandidate, cam: Camera): ScreenBox {
  const rot = c.rot ?? 0;
  let x0 = c.x;
  let y0 = c.y;
  let x1 = c.x + c.w;
  let y1 = c.y + c.h;
  if (rot !== 0) {
    const a = rot * DEG;
    const cos = Math.abs(Math.cos(a));
    const sin = Math.abs(Math.sin(a));
    const bw = c.w * cos + c.h * sin;
    const bh = c.w * sin + c.h * cos;
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    x0 = cx - bw / 2;
    x1 = cx + bw / 2;
    y0 = cy - bh / 2;
    y1 = cy + bh / 2;
  }
  return {
    x0: cam.tx + x0 * cam.scale,
    y0: cam.ty + y0 * cam.scale,
    x1: cam.tx + x1 * cam.scale,
    y1: cam.ty + y1 * cam.scale,
  };
}

const overlap = (a: ScreenBox, b: ScreenBox): number => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
};

// The ids that should play, best first: the big enough cards in the viewport (by the area they show, then
// the nearest to the centre), then the ones only in the margin (by their size), up to the cap. Ties break
// on the id, so the answer does not depend on the order the cards arrive in.
export function planAmbient(input: AmbientPlanInput): string[] {
  const { camera, viewport } = input;
  const cap = Math.min(input.cap ?? AMBIENT_MAX_PLAYING, AMBIENT_MAX_STREAMS);
  if (!(cap > 0) || viewport.w <= 0 || viewport.h <= 0) return [];
  const minPx = input.minPlayPx ?? AMBIENT_MIN_PLAY_PX;
  const m = input.margin ?? AMBIENT_MARGIN;
  const view: ScreenBox = { x0: 0, y0: 0, x1: viewport.w, y1: viewport.h };
  const near: ScreenBox = {
    x0: -viewport.w * m,
    y0: -viewport.h * m,
    x1: viewport.w * (1 + m),
    y1: viewport.h * (1 + m),
  };
  const cx = viewport.w / 2;
  const cy = viewport.h / 2;
  const scored: { id: string; inView: boolean; score: number; dist: number }[] = [];
  for (const c of input.cards) {
    if (Math.max(c.w, c.h) * camera.scale < minPx) continue;
    const box = screenBox(c, camera);
    const visible = overlap(box, view);
    const inView = visible > 0;
    if (!inView && overlap(box, near) === 0) continue;
    const size = (box.x1 - box.x0) * (box.y1 - box.y0);
    let score = inView ? visible : size;
    if (input.playing?.has(c.id)) score *= KEEP_BONUS;
    const dist = Math.hypot((box.x0 + box.x1) / 2 - cx, (box.y0 + box.y1) / 2 - cy);
    scored.push({ id: c.id, inView, score, dist });
  }
  scored.sort(
    (a, b) =>
      Number(b.inView) - Number(a.inView) ||
      b.score - a.score ||
      a.dist - b.dist ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return (scored.length > cap ? scored.slice(0, cap) : scored).map((s) => s.id);
}

// What the page lets us do. Injected so the pool runs under test; the default reads the browser.
export interface AmbientEnv {
  // The user asked for less motion: nothing plays on its own.
  reducedMotion(): boolean;
  // Data saver is on: no stream starts on its own.
  saveData(): boolean;
  // The tab is in the background.
  hidden(): boolean;
}

interface NetworkInformationLike {
  saveData?: boolean;
}

export const browserAmbientEnv: AmbientEnv = {
  reducedMotion: () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  saveData: () =>
    (navigator as Navigator & { connection?: NetworkInformationLike }).connection?.saveData ===
    true,
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
};

// May videos start on their own at all?
export function ambientAllowed(env: AmbientEnv): boolean {
  return !env.reducedMotion() && !env.saveData();
}
