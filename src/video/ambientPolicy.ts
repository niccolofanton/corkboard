// Which video cards play on their own in `mode: 'always'` (ambient.ts)? Pure rules shared by the pool
// and its tests. No DOM, no timers.
//
// "Always" means every video card on screen plays, at any zoom: there is no size threshold and no
// per-device cap on what the viewport shows. Only the cards that touch the viewport (plus a margin, so a
// card scrolling in is already moving) have a stream; a card that scrolls away is let go of.
//
// The one limit is a safety ceiling (`AMBIENT_MAX_STREAMS`): a <video> is a decoder and a socket, and a
// canvas of hundreds of video cards zoomed all the way out must not open hundreds of them. Past it the
// cards in view win over the ones in the margin, the biggest on screen first.
import type { Camera } from '../math';
import { DEG } from '../interact/geometry';

// Streams that may run at once, whatever the canvas shows: a ceiling against a runaway canvas, well past
// what a person puts on one screen.
export const AMBIENT_MAX_STREAMS = 96;
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
  // At most this many ids (default `AMBIENT_MAX_STREAMS`).
  cap?: number;
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

// The ids that should play, best first: every card in the viewport (by the area it shows), then the ones
// only in the margin (by their size), up to the ceiling. Ties break on the id, so the answer does not
// depend on the order the cards arrive in.
export function planAmbient(input: AmbientPlanInput): string[] {
  const { camera, viewport } = input;
  const cap = input.cap ?? AMBIENT_MAX_STREAMS;
  if (cap <= 0 || viewport.w <= 0 || viewport.h <= 0) return [];
  const m = input.margin ?? AMBIENT_MARGIN;
  const view: ScreenBox = { x0: 0, y0: 0, x1: viewport.w, y1: viewport.h };
  const near: ScreenBox = {
    x0: -viewport.w * m,
    y0: -viewport.h * m,
    x1: viewport.w * (1 + m),
    y1: viewport.h * (1 + m),
  };
  const scored: { id: string; inView: boolean; score: number }[] = [];
  for (const c of input.cards) {
    const box = screenBox(c, camera);
    const visible = overlap(box, view);
    const inView = visible > 0;
    if (!inView && overlap(box, near) === 0) continue;
    const size = (box.x1 - box.x0) * (box.y1 - box.y0);
    let score = inView ? visible : size;
    if (input.playing?.has(c.id)) score *= KEEP_BONUS;
    scored.push({ id: c.id, inView, score });
  }
  scored.sort(
    (a, b) =>
      Number(b.inView) - Number(a.inView) ||
      b.score - a.score ||
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
