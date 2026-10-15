// Auto spot: where an inserted block goes when nobody places it by hand. Search outward from the
// viewport centre for the nearest free position.
import { boxCx, boxCy, boxH, boxW, type Box } from '../interact/geometry';

const DEFAULT_STEP = 48;
const DEFAULT_MAX_RADIUS_FACTOR = 2;
// First window of the search, in rings. The window doubles until the bound, so a mostly empty
// board never pays for the big lattice.
const INITIAL_RINGS = 8;
// Hard cap on rings (lattice of (2 * 160 + 1)^2 = 103k cells). A viewport at very low zoom spans
// hundreds of thousands of world px: past the cap the step grows so 2 diagonals still fit.
const MAX_RINGS = 160;
// Tolerance in lattice units so boxes that exactly touch (floating point noise included) stay free.
const EPS = 1e-9;

// The lattice the search runs on: the block centred on the viewport (ox, oy is its top-left), the step,
// and how many rings out the search goes. NaN or infinite inputs give a non-finite `maxRadius`.
function searchPlan(
  block: { w: number; h: number },
  viewport: Box,
  opts: { step?: number; maxRadiusFactor?: number },
): { ox: number; oy: number; step: number; maxRings: number; maxRadius: number } {
  const step0 = opts.step !== undefined && opts.step > 0 ? opts.step : DEFAULT_STEP;
  const factor = opts.maxRadiusFactor ?? DEFAULT_MAX_RADIUS_FACTOR;
  // Top-left of the block when centred on the viewport.
  const ox = boxCx(viewport) - block.w / 2;
  const oy = boxCy(viewport) - block.h / 2;
  const maxRadius = factor * Math.hypot(boxW(viewport), boxH(viewport));

  let step = step0;
  let maxRings = Math.max(1, Math.floor(maxRadius / step));
  if (maxRings > MAX_RINGS) {
    maxRings = MAX_RINGS;
    step = maxRadius / MAX_RINGS;
  }
  return { ox, oy, step, maxRings, maxRadius };
}

// The world area `autoSpot` can put the block in: only boxes meeting it can block a candidate. Query the
// store for this, not for the viewport: the search reaches 2 viewport diagonals out, and the block's own
// size past that.
export function autoSpotArea(
  block: { w: number; h: number },
  viewport: Box,
  opts: { step?: number; maxRadiusFactor?: number } = {},
): Box {
  const { ox, oy, step, maxRings } = searchPlan(block, viewport, opts);
  const reach = step * maxRings;
  return { minX: ox - reach, minY: oy - reach, maxX: ox + block.w + reach, maxY: oy + block.h + reach };
}

// How the search works: the block's top-left at lattice point p overlaps the box B exactly when
// p lies strictly inside B grown by the block's size on its min sides, i.e. in the open range
// (B.min - blockSize, B.max). So instead of testing every candidate against every box, each
// box paints a rectangle of lattice cells into a 2D difference array; one prefix-sum pass then
// tells whether any candidate is blocked. Cost: O(boxes + cells), independent of block size.
export function autoSpot(
  block: { w: number; h: number },
  viewport: Box,
  occupied: readonly Box[],
  opts: { step?: number; maxRadiusFactor?: number } = {},
): { x: number; y: number } {
  const { ox, oy, step, maxRings, maxRadius } = searchPlan(block, viewport, opts);
  // A non-finite viewport or block has no lattice (the ring loop would never end): the centre, or the
  // origin when even that is not a number.
  if (!Number.isFinite(maxRadius) || !Number.isFinite(ox) || !Number.isFinite(oy)) {
    return { x: Number.isFinite(ox) ? ox : 0, y: Number.isFinite(oy) ? oy : 0 };
  }

  let rings = Math.min(maxRings, INITIAL_RINGS);
  let from = 0; // first ring not yet known to be fully blocked
  for (;;) {
    const found = searchRings(block, ox, oy, step, occupied, rings, from);
    if (found) return { x: ox + found.i * step, y: oy + found.j * step };
    if (rings >= maxRings) break;
    from = rings + 1;
    rings = Math.min(maxRings, rings * 2);
  }
  return { x: ox, y: oy };
}

// Lattice offsets (i, j) in steps of the first free candidate in rings [from, rings], or null.
// Ring r holds the offsets with max(|i|, |j|) = r; within a ring the nearest to the centre wins
// and distance ties go to the first in reading order (top row first, then left).
function searchRings(
  block: { w: number; h: number },
  ox: number,
  oy: number,
  step: number,
  occupied: readonly Box[],
  rings: number,
  from: number,
): { i: number; j: number } | null {
  const R = rings;
  const side = 2 * R + 1;
  const stride = side + 1; // one extra row/column for the difference array's far edge
  const grid = new Int32Array(stride * stride);

  for (let k = 0; k < occupied.length; k++) {
    const b = occupied[k];
    let i0 = Math.floor((b.minX - block.w - ox) / step + EPS) + 1;
    let i1 = Math.ceil((b.maxX - ox) / step - EPS) - 1;
    let j0 = Math.floor((b.minY - block.h - oy) / step + EPS) + 1;
    let j1 = Math.ceil((b.maxY - oy) / step - EPS) - 1;
    if (i0 < -R) i0 = -R;
    if (j0 < -R) j0 = -R;
    if (i1 > R) i1 = R;
    if (j1 > R) j1 = R;
    // Also rejects NaN (invalid boxes) and empty boxes (min = Infinity).
    if (!(i0 <= i1) || !(j0 <= j1)) continue;
    const a = (j0 + R) * stride + (i0 + R);
    const di = i1 - i0 + 1;
    const dj = (j1 - j0 + 1) * stride;
    grid[a] += 1;
    grid[a + di] -= 1;
    grid[a + dj] -= 1;
    grid[a + di + dj] += 1;
  }

  // 2D prefix sum in place: grid[j][i] becomes the number of boxes blocking that lattice cell.
  for (let j = 0; j < side; j++) {
    const row = j * stride;
    let run = 0;
    for (let i = 0; i < side; i++) {
      run += grid[row + i];
      grid[row + i] = j > 0 ? run + grid[row - stride + i] : run;
    }
  }

  const free = (i: number, j: number): boolean => grid[(j + R) * stride + (i + R)] === 0;

  if (from === 0 && free(0, 0)) return { i: 0, j: 0 };
  for (let r = Math.max(1, from); r <= R; r++) {
    let bestI = 0;
    let bestJ = 0;
    let bestD = Infinity;
    // Reading order over the ring's perimeter: the top row, the two side cells of each middle
    // row, the bottom row. The strict `<` keeps the first of equally distant candidates.
    for (let j = -r; j <= r; j++) {
      const edge = j === -r || j === r;
      for (let i = -r; i <= r; i += edge ? 1 : 2 * r) {
        const d = i * i + j * j;
        if (d < bestD && free(i, j)) {
          bestD = d;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestD < Infinity) return { i: bestI, j: bestJ };
  }
  return null;
}

// True when more than half of the block lies outside the viewport: the camera then flies there.
// Exactly half visible does not count.
export function shouldPanTo(block: Box, viewport: Box): boolean {
  const area = boxW(block) * boxH(block);
  if (area <= 0) {
    // A degenerate block (a line, a point): judge by its centre.
    const x = boxCx(block);
    const y = boxCy(block);
    return x < viewport.minX || x > viewport.maxX || y < viewport.minY || y > viewport.maxY;
  }
  const iw = Math.min(block.maxX, viewport.maxX) - Math.max(block.minX, viewport.minX);
  const ih = Math.min(block.maxY, viewport.maxY) - Math.max(block.minY, viewport.minY);
  const inside = iw > 0 && ih > 0 ? iw * ih : 0;
  return inside < area / 2;
}
