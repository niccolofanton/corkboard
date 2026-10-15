// Snapping of edges, centres, gaps and sizes, plus the guide model. Pure: no Pixi, no DOM.
//
// While a box is moved or resized it snaps, X and Y independently, to four families of targets:
//  - alignment: its left / centre / right (top / middle / bottom) lines against the same lines of
//    nearby elements;
//  - equal gaps (move, and the dragged edge of a resize): the gap to the nearest neighbour on its row
//    (column) becomes equal to a gap already present between two elements of that row (column), or the
//    box centres itself between its two neighbours so both gaps are equal;
//  - width / height match (resize of one edge): the box takes the width (height) of a nearby element on
//    its row or in its column.
// The smallest |delta| within the threshold wins; on a tie alignment beats a size match, which beats a
// gap. The caller converts the SNAP_THRESHOLD_PX screen threshold to world units (`/ zoom`, so it feels
// the same at every zoom) and passes the candidates (viewport grown by 25 %, nearest N) once per drag.
// Hysteresis: a result object reused across a drag remembers each axis' winner, which then holds
// until the box is SNAP_RELEASE thresholds away from it or another target is clearly nearer
// (SNAP_SWITCH thresholds), so the box never chatters between two targets or across the threshold. `SnapIndex` is built once from them:
// sorted lines per axis, the owner boxes, the gaps between neighbouring boxes (sorted by size) and the
// sorted widths / heights. A move then costs a few binary searches plus one linear pass over the
// candidates to find the box's neighbours, with no allocation beyond the guide objects.
import type { Box } from './geometry';

export interface SnapCandidate {
  id: string;
  box: Box;
}

// Screen px: the snap threshold and how far a guide runs past its outermost marker. Callers divide by
// the zoom.
export const SNAP_THRESHOLD_PX = 6;
export const GUIDE_OVERSHOOT_PX = 3;
// Hysteresis, in thresholds: a held target lets go beyond SNAP_RELEASE, and a new target takes over
// only when it is nearer than the held one by more than SNAP_SWITCH.
export const SNAP_RELEASE = 1.5;
export const SNAP_SWITCH = 0.5;

// Lines closer than this (world units) count as the same line: it collects coincident candidates into
// one guide and absorbs floating point noise left by the correction.
export const SNAP_EPS = 0.01;

// An alignment guide. A vertical guide (axis 'x') is the line x = `at` running from y = `from` to
// y = `to`; a horizontal guide (axis 'y') is the line y = `at` running from x = `from` to x = `to`.
// World units. `kind` follows the moving line that produced it ('center' for the centre / middle line,
// 'edge' for the outer ones).
// `marks`: where the line meets each aligned box, sorted (positions along the line, world units): the
// two corners of a box aligned by an edge, the midpoint of one aligned by its centre, for the moving
// box and the candidates on the line nearest to it (at most six). The span runs from the first mark to
// the last plus the overshoot.
export interface LineGuide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
  kind: 'edge' | 'center';
  marks?: number[];
}

// A measurement marker. NOTE the axis convention differs from `LineGuide`: here `axis` is the direction
// the measured segment RUNS along. A segment along 'x' is horizontal: it sits at y = `at` and runs from
// x = `from` to x = `to`; along 'y' it is vertical at x = `at`, from y = `from` to y = `to`. World units.
//  - 'gap': the empty space between two boxes, `label` = its size in world px, rounded to an integer.
//    Emitted for the moving box's own gap(s) and for each existing gap it was matched to; `at` is the
//    middle of the range the two boxes face each other over.
//  - 'width' (axis 'x') / 'height' (axis 'y'): the extent of one box, spanning from edge to edge, drawn
//    at the middle of the box (`at`). Emitted for the resized box and for each box whose extent it was
//    matched to; `label` = the extent in world px, rounded (the overlay draws "=" instead).
export interface MeasureGuide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
  kind: 'gap' | 'width';
  label: number;
}

// Every guide carries `axis`, `at`, `from`, `to` and `kind`; tell the families apart by `kind`.
export type Guide = LineGuide | MeasureGuide;

// `dx` / `dy`: the correction to ADD to the moving box (0 when that axis does not snap). A box that
// already lies on a line reports 0 and still carries the guide.
export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
  // A resize that flags both opposite edges of an axis (a symmetric resize): the edge `dx` / `dy` applies to.
  // Absent when that axis did not snap, or for a move.
  edgeX?: 'min' | 'max';
  edgeY?: 'min' | 'max';
}

export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

// Line kinds (candidate lines and moving lines share the first two).
const EDGE = 0;
const CENTER = 1;

// Which family won an axis.
const WIN_NONE = 0;
const WIN_ALIGN = 1;
const WIN_SIZE = 2;
const WIN_GAP = 3;

// Gaps are only collected among the first 400 candidate boxes (the engine never passes more): the
// neighbour search at build time is quadratic in the worst case.
const GAP_BOX_CAP = 400;
// A box looks at most this many closer boxes deep when it collects its neighbours.
const MAX_BLOCKERS = 64;
// At most this many existing gaps / matched boxes are drawn next to the moving box's own (the nearest
// ones: a far match adds clutter, not information). The scan for the nearest is bounded too.
const MAX_REF_GAPS = 3;
const MAX_SIZE_MATCHES = 3;
const REF_GAP_SCAN = 256;

const AXES = ['x', 'y'] as const;

interface AxisLines {
  // Sorted line positions, with the owner (index into `boxes`) and kind of each line.
  readonly v: Float64Array;
  readonly owner: Int32Array;
  readonly kind: Uint8Array;
}

// The gaps along one axis, sorted by size: each is the empty space between two candidate boxes that
// face each other over a positive length of the other axis, with nothing between them.
interface GapList {
  readonly v: Float64Array;
  // Owners of the box before (smaller coordinate) and after the gap.
  readonly before: Int32Array;
  readonly after: Int32Array;
}

// The extents (widths or heights) of the candidate boxes, sorted.
interface SizeList {
  readonly v: Float64Array;
  readonly owner: Int32Array;
}

// Opaque to callers: build it with `buildSnapIndex`, hand it back to `snapMove` / `snapResize`.
export interface SnapIndex {
  // Number of owners (the candidates that were usable).
  readonly count: number;
  readonly candCount: number;
  readonly ids: readonly string[];
  // Four numbers per owner: minX, minY, maxX, maxY.
  readonly boxes: Float64Array;
  readonly x: AxisLines;
  readonly y: AxisLines;
  // Horizontal gaps (boxes side by side on a row) and vertical gaps (boxes stacked in a column).
  readonly gapsX: GapList;
  readonly gapsY: GapList;
  readonly widths: SizeList;
  readonly heights: SizeList;
}

const EMPTY_LINES: AxisLines = {
  v: new Float64Array(0),
  owner: new Int32Array(0),
  kind: new Uint8Array(0),
};

const EMPTY_GAPS: GapList = {
  v: new Float64Array(0),
  before: new Int32Array(0),
  after: new Int32Array(0),
};

const EMPTY_SIZES: SizeList = { v: new Float64Array(0), owner: new Int32Array(0) };

// The indices 0..n-1 ordered by `key`.
function sortedOrder(key: ArrayLike<number>, n: number): Uint32Array {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => key[a] - key[b]);
  return order;
}

// Sort the raw (value, owner, kind) triples by value. A permutation sort keeps the three arrays
// parallel without packing; the order among equal values is irrelevant (runs are scanned whole).
function sortLines(
  rawV: Float64Array,
  rawOwner: Int32Array,
  rawKind: Uint8Array,
  n: number,
): AxisLines {
  if (n === 0) return EMPTY_LINES;
  const order = sortedOrder(rawV, n);
  const v = new Float64Array(n);
  const owner = new Int32Array(n);
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = order[i];
    v[i] = rawV[s];
    owner[i] = rawOwner[s];
    kind[i] = rawKind[s];
  }
  return { v, owner, kind };
}

function validBox(b: Box): boolean {
  return (
    Number.isFinite(b.minX) &&
    Number.isFinite(b.minY) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.maxY) &&
    b.maxX >= b.minX &&
    b.maxY >= b.minY
  );
}

// The extent of every candidate box along `ax` (0: width, 1: height), sorted.
function buildSizes(boxes: Float64Array, n: number, ax: number): SizeList {
  if (n === 0) return EMPTY_SIZES;
  const raw = new Float64Array(n);
  for (let o = 0; o < n; o++) raw[o] = boxes[o * 4 + ax + 2] - boxes[o * 4 + ax];
  const order = sortedOrder(raw, n);
  const v = new Float64Array(n);
  const owner = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = raw[order[i]];
    owner[i] = order[i];
  }
  return { v, owner };
}

// The gaps between neighbouring boxes along `ax` (0: horizontal gaps, 1: vertical ones). For each box
// `a` the boxes that start at or after its far edge and face it over a positive length of the other
// axis are visited nearest first; one is a neighbour unless a closer neighbour of `a` already hides the
// whole stretch they face each other over. Touching neighbours (no gap) are neighbours too: they hide
// what lies behind them. O(n log n) for the sort plus, per box, the scan over what lies on its side,
// which stops as soon as the closer boxes cover its whole extent (bounded by MAX_BLOCKERS).
function buildGaps(boxes: Float64Array, n: number, ax: number): GapList {
  if (n < 2) return EMPTY_GAPS;
  const pa = 1 - ax;
  const keys = new Float64Array(n);
  for (let o = 0; o < n; o++) keys[o] = boxes[o * 4 + ax];
  const order = sortedOrder(keys, n);
  const sortedLo = new Float64Array(n);
  for (let i = 0; i < n; i++) sortedLo[i] = keys[order[i]];
  const blkLo = new Float64Array(MAX_BLOCKERS);
  const blkHi = new Float64Array(MAX_BLOCKERS);
  const gv: number[] = [];
  const gBefore: number[] = [];
  const gAfter: number[] = [];

  for (let i = 0; i < n; i++) {
    const a = order[i];
    const ka = a * 4;
    const aHi = boxes[ka + ax + 2];
    const aPlo = boxes[ka + pa];
    const aPhi = boxes[ka + pa + 2];
    let nb = 0;
    // The union of what the accepted neighbours cover of `a`'s extent (only growing runs that touch the
    // first one: it is an early exit, a miss just scans further).
    let covLo = Infinity;
    let covHi = -Infinity;
    for (let j = lowerBound(sortedLo, aHi - SNAP_EPS); j < n; j++) {
      const b = order[j];
      if (b === a) continue;
      const kb = b * 4;
      const ovLo = Math.max(aPlo, boxes[kb + pa]);
      const ovHi = Math.min(aPhi, boxes[kb + pa + 2]);
      if (!(ovHi > ovLo)) continue;
      let hidden = false;
      for (let m = 0; m < nb; m++) {
        if (blkLo[m] <= ovLo + SNAP_EPS && blkHi[m] >= ovHi - SNAP_EPS) {
          hidden = true;
          break;
        }
      }
      if (hidden) continue;
      const gap = boxes[kb + ax] - aHi;
      if (gap > SNAP_EPS) {
        gv.push(gap);
        gBefore.push(a);
        gAfter.push(b);
      }
      if (nb === MAX_BLOCKERS) break;
      blkLo[nb] = boxes[kb + pa];
      blkHi[nb] = boxes[kb + pa + 2];
      nb++;
      if (covHi < covLo) {
        covLo = ovLo;
        covHi = ovHi;
      } else if (ovLo <= covHi + SNAP_EPS && ovHi >= covLo - SNAP_EPS) {
        if (ovLo < covLo) covLo = ovLo;
        if (ovHi > covHi) covHi = ovHi;
      }
      if (covLo <= aPlo + SNAP_EPS && covHi >= aPhi - SNAP_EPS) break;
    }
  }

  const m = gv.length;
  if (m === 0) return EMPTY_GAPS;
  const perm = sortedOrder(gv, m);
  const v = new Float64Array(m);
  const before = new Int32Array(m);
  const after = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const s = perm[i];
    v[i] = gv[s];
    before[i] = gBefore[s];
    after[i] = gAfter[s];
  }
  return { v, before, after };
}

// O(n log n) for the lines and sizes, done once at drag start; the gaps cost a bounded quadratic pass
// over at most GAP_BOX_CAP boxes. Candidates give left / centre / right and top / middle / bottom
// lines, gaps and sizes. Boxes that are not finite are ignored.
export function buildSnapIndex(candidates: readonly SnapCandidate[]): SnapIndex {
  const maxOwners = candidates.length;
  const boxes = new Float64Array(maxOwners * 4);
  const ids: string[] = [];
  const maxLines = candidates.length * 3;
  const xv = new Float64Array(maxLines);
  const xo = new Int32Array(maxLines);
  const xk = new Uint8Array(maxLines);
  const yv = new Float64Array(maxLines);
  const yo = new Int32Array(maxLines);
  const yk = new Uint8Array(maxLines);
  let owners = 0;
  let nx = 0;
  let ny = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const b = c.box;
    if (!validBox(b)) continue;
    const o = owners++;
    ids.push(c.id);
    boxes[o * 4] = b.minX;
    boxes[o * 4 + 1] = b.minY;
    boxes[o * 4 + 2] = b.maxX;
    boxes[o * 4 + 3] = b.maxY;
    xv[nx] = b.minX;
    xo[nx] = o;
    xk[nx++] = EDGE;
    xv[nx] = (b.minX + b.maxX) / 2;
    xo[nx] = o;
    xk[nx++] = CENTER;
    xv[nx] = b.maxX;
    xo[nx] = o;
    xk[nx++] = EDGE;
    yv[ny] = b.minY;
    yo[ny] = o;
    yk[ny++] = EDGE;
    yv[ny] = (b.minY + b.maxY) / 2;
    yo[ny] = o;
    yk[ny++] = CENTER;
    yv[ny] = b.maxY;
    yo[ny] = o;
    yk[ny++] = EDGE;
  }
  const candCount = owners;

  const gapBoxes = Math.min(candCount, GAP_BOX_CAP);
  return {
    count: owners,
    candCount,
    ids,
    boxes,
    x: sortLines(xv, xo, xk, nx),
    y: sortLines(yv, yo, yk, ny),
    gapsX: buildGaps(boxes, gapBoxes, 0),
    gapsY: buildGaps(boxes, gapBoxes, 1),
    widths: buildSizes(boxes, candCount, 0),
    heights: buildSizes(boxes, candCount, 1),
  };
}

// First index whose value is >= x (v.length when none).
function lowerBound(v: Float64Array, x: number): number {
  let lo = 0;
  let hi = v.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (v[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Tie-break between matches at the same distance: centre-to-centre, then edge-to-edge, then a mixed
// pair (an edge on a centre).
function pairRank(movingKind: number, lineKind: number): number {
  if (movingKind === CENTER) return lineKind === CENTER ? 0 : 2;
  return lineKind === CENTER ? 2 : 1;
}

// Scratch for the axis search (module level: the search runs on the main thread only and never
// re-enters, and it keeps the per-move path free of allocations).
let bestFound = false;
let bestAbs = 0;
let bestDelta = 0;
let bestRank = 0;
let bestLine = 0;

// Evaluate the run of equal-valued lines that starts at `start` and extends in `dir`, then keep it if
// it beats the best match so far (smaller |delta| wins; within SNAP_EPS the better rank wins; a full
// tie keeps the earlier one, so the result is deterministic).
function consider(
  lines: AxisLines,
  start: number,
  dir: 1 | -1,
  abs: number,
  delta: number,
  movingKind: number,
  movingLine: number,
): void {
  const v = lines.v;
  const w = v[start];
  let rank = 4;
  for (let j = start; j >= 0 && j < v.length && Math.abs(v[j] - w) <= SNAP_EPS; j += dir) {
    const r = pairRank(movingKind, lines.kind[j]);
    if (r < rank) rank = r;
  }
  if (!bestFound || abs < bestAbs - SNAP_EPS || (abs <= bestAbs + SNAP_EPS && rank < bestRank)) {
    bestFound = true;
    bestAbs = abs;
    bestDelta = delta;
    bestRank = rank;
    bestLine = movingLine;
  }
}

// Find the nearest line to `m` on each side, within the threshold, and feed them to `consider`.
function probe(
  lines: AxisLines,
  m: number,
  movingKind: number,
  movingLine: number,
  threshold: number,
): void {
  const v = lines.v;
  const n = v.length;
  if (n === 0) return;
  const i = lowerBound(v, m);
  if (i < n) {
    const abs = v[i] - m;
    if (abs <= threshold) consider(lines, i, 1, abs, v[i] - m, movingKind, movingLine);
  }
  if (i > 0) {
    const abs = m - v[i - 1];
    if (abs <= threshold) consider(lines, i - 1, -1, abs, v[i - 1] - m, movingKind, movingLine);
  }
}

// ── Equal gaps ────────────────────────────────────────────────────────────────────────────────────

// The moving box and the box the guides are measured from (min x, min y, max x, max y).
const mv = new Float64Array(4);
const fb = new Float64Array(4);

// Neighbours of the moving box along an axis (owner and facing edge; owner -1 when there is none).
let nbBefore = -1;
let nbAfter = -1;
let nbBeforeEdge = 0;
let nbAfterEdge = 0;

// The nearest candidate box before (ending at or before `m0`) and after (starting at or after `m1`)
// the span m0..m1 of axis `ax`, among those that overlap p0..p1 on the other axis. Nothing lies
// between the box and its neighbour: any such box would be nearer.
function findNeighbours(
  index: SnapIndex,
  ax: number,
  m0: number,
  m1: number,
  p0: number,
  p1: number,
): void {
  const boxes = index.boxes;
  const pa = 1 - ax;
  const n = index.candCount;
  let before = -1;
  let after = -1;
  let beforeEdge = -Infinity;
  let afterEdge = Infinity;
  for (let o = 0; o < n; o++) {
    const k = o * 4;
    if (!(boxes[k + pa + 2] > p0 && boxes[k + pa] < p1)) continue;
    const hi = boxes[k + ax + 2];
    if (hi <= m0 + SNAP_EPS) {
      if (hi > beforeEdge) {
        beforeEdge = hi;
        before = o;
      }
    } else {
      const lo = boxes[k + ax];
      if (lo >= m1 - SNAP_EPS && lo < afterEdge) {
        afterEdge = lo;
        after = o;
      }
    }
  }
  nbBefore = before;
  nbAfter = after;
  nbBeforeEdge = beforeEdge;
  nbAfterEdge = afterEdge;
}

// Does gap `j` sit on the moving box's row (column): do its two boxes face each other over part of
// p0..p1 of the other axis?
function gapInRow(
  index: SnapIndex,
  gl: GapList,
  j: number,
  pa: number,
  p0: number,
  p1: number,
): boolean {
  const b = index.boxes;
  const ka = gl.before[j] * 4;
  const kb = gl.after[j] * 4;
  const lo = Math.max(b[ka + pa], b[kb + pa]);
  const hi = Math.min(b[ka + pa + 2], b[kb + pa + 2]);
  return hi > p0 && lo < p1;
}

// Best gap snap so far on the current axis.
let gapFound = false;
let gapAbs = 0;
let gapDelta = 0;
let gapLine = 0;
let gapSize = 0;

function offerGap(abs: number, delta: number, line: number, size: number): void {
  if (!gapFound || abs < gapAbs - SNAP_EPS) {
    gapFound = true;
    gapAbs = abs;
    gapDelta = delta;
    gapLine = line;
    gapSize = size;
  }
}

// The existing gaps nearest to the moving box's current gap `gc`, in both directions and within the
// threshold, that sit on its row. `sign` is +1 when the moving edge is the min one (the gap grows with
// the coordinate) and -1 when it is the max one.
function probeGapSizes(
  index: SnapIndex,
  gl: GapList,
  gc: number,
  sign: number,
  line: number,
  pa: number,
  p0: number,
  p1: number,
  threshold: number,
): void {
  const v = gl.v;
  const n = v.length;
  if (n === 0) return;
  const i = lowerBound(v, gc);
  for (let j = i; j < n; j++) {
    const d = v[j] - gc;
    if (d > threshold) break;
    if (gapInRow(index, gl, j, pa, p0, p1)) {
      offerGap(d, sign * d, line, v[j]);
      break;
    }
  }
  for (let j = i - 1; j >= 0; j--) {
    const d = gc - v[j];
    if (d > threshold) break;
    if (gapInRow(index, gl, j, pa, p0, p1)) {
      offerGap(d, -sign * d, line, v[j]);
      break;
    }
  }
}

// Gap snaps along axis `ax` for the moving box `mv`. A whole box may match either of its neighbours'
// gaps to an existing one, or centre itself between them; a resize only moves the dragged edge, so only
// the gap on that side counts (`mask` is 1 for the min edge, 4 for the max one).
function probeGaps(
  index: SnapIndex,
  ax: number,
  mask: number,
  wholeBox: boolean,
  threshold: number,
): void {
  gapFound = false;
  if (index.candCount === 0) return;
  const pa = 1 - ax;
  const m0 = mv[ax];
  const m1 = mv[ax + 2];
  const p0 = mv[pa];
  const p1 = mv[pa + 2];
  findNeighbours(index, ax, m0, m1, p0, p1);
  const before = nbBefore;
  const after = nbAfter;
  const beforeEdge = nbBeforeEdge;
  const afterEdge = nbAfterEdge;
  const gl = ax === 0 ? index.gapsX : index.gapsY;
  if (wholeBox && before >= 0 && after >= 0) {
    const free = afterEdge - beforeEdge - (m1 - m0);
    if (free > 2 * SNAP_EPS) {
      const delta = beforeEdge + free / 2 - m0;
      const abs = Math.abs(delta);
      if (abs <= threshold) offerGap(abs, delta, 0, free / 2);
    }
  }
  if (before >= 0 && (wholeBox || mask === 1)) {
    probeGapSizes(index, gl, m0 - beforeEdge, 1, 0, pa, p0, p1, threshold);
  }
  if (after >= 0 && (wholeBox || mask === 4)) {
    probeGapSizes(index, gl, afterEdge - m1, -1, 2, pa, p0, p1, threshold);
  }
}

// ── Width / height match ──────────────────────────────────────────────────────────────────────────

// Best size match so far on the current axis.
let sizeFound = false;
let sizeAbs = 0;
let sizeDelta = 0;
let sizeOwner = -1;

function offerSize(abs: number, delta: number, owner: number): void {
  if (!sizeFound || abs < sizeAbs - SNAP_EPS) {
    sizeFound = true;
    sizeAbs = abs;
    sizeDelta = delta;
    sizeOwner = owner;
  }
}

// A box to match sizes with: one on the moving box's row (it overlaps p0..p1) or in its column (it
// overlaps m0..m1). Far-away boxes elsewhere on the board do not count.
function nearbyForSize(
  boxes: Float64Array,
  o: number,
  ax: number,
  m0: number,
  m1: number,
  p0: number,
  p1: number,
): boolean {
  const k = o * 4;
  const pa = 1 - ax;
  return (
    (boxes[k + pa + 2] > p0 && boxes[k + pa] < p1) || (boxes[k + ax + 2] > m0 && boxes[k + ax] < m1)
  );
}

// Resizing the `edge` (0: min, 2: max) of the moving box along `ax`: the box takes the extent of a
// nearby box when its current extent is within the threshold of it. The nearest extent in each
// direction that belongs to a nearby box counts.
function probeSizes(index: SnapIndex, ax: number, edge: number, threshold: number): void {
  sizeFound = false;
  const sizes = ax === 0 ? index.widths : index.heights;
  const v = sizes.v;
  const n = v.length;
  if (n === 0) return;
  const pa = 1 - ax;
  const m0 = mv[ax];
  const m1 = mv[ax + 2];
  const p0 = mv[pa];
  const p1 = mv[pa + 2];
  const w = m1 - m0;
  const boxes = index.boxes;
  const i = lowerBound(v, w);
  for (let j = i; j < n; j++) {
    const d = v[j] - w;
    if (d > threshold) break;
    if (nearbyForSize(boxes, sizes.owner[j], ax, m0, m1, p0, p1)) {
      offerSize(d, edge === 2 ? d : -d, sizes.owner[j]);
      break;
    }
  }
  for (let j = i - 1; j >= 0; j--) {
    const d = w - v[j];
    if (d > threshold) break;
    if (nearbyForSize(boxes, sizes.owner[j], ax, m0, m1, p0, p1)) {
      offerSize(d, edge === 2 ? -d : d, sizes.owner[j]);
      break;
    }
  }
}

// ── One axis ──────────────────────────────────────────────────────────────────────────────────────

// Outcome per axis (index 0: x, 1: y). `axLine` is the moving line that carries the correction (0: min
// edge, 1: centre, 2: max edge; for a whole box any value counts as the whole box shifting).
const axWin = new Uint8Array(2);
const axLine = new Int8Array(2);
const axDelta = new Float64Array(2);
// The gap size a gap snap aims at, the box a size snap matches, and the neighbours of a gap snap.
const axGap = new Float64Array(2);
const axOwner = new Int32Array(2);
const axBefore = new Int32Array(2);
const axAfter = new Int32Array(2);

// Alignment, size match and gap snap compete: the smallest |delta| wins, and within SNAP_EPS an
// alignment beats a size match, which beats a gap.
function snapAxis(
  index: SnapIndex,
  ax: number,
  mask: number,
  wholeBox: boolean,
  threshold: number,
  st: Sticky | null,
): void {
  const lines = ax === 0 ? index.x : index.y;
  const lo = mv[ax];
  const hi = mv[ax + 2];
  let win = WIN_NONE;
  let abs = 0;
  let delta = 0;
  let line = -1;

  bestFound = false;
  if (mask & 1) probe(lines, lo, EDGE, 0, threshold);
  if (mask & 2) probe(lines, (lo + hi) / 2, CENTER, 1, threshold);
  if (mask & 4) probe(lines, hi, EDGE, 2, threshold);
  if (bestFound) {
    win = WIN_ALIGN;
    abs = bestAbs;
    delta = bestDelta;
    line = bestLine;
  }

  // Sizes and gaps of a resize only make sense for one dragged edge (a symmetric resize moves both).
  if (!wholeBox && (mask === 1 || mask === 4)) {
    probeSizes(index, ax, mask === 1 ? 0 : 2, threshold);
    if (sizeFound && (win === WIN_NONE || sizeAbs < abs - SNAP_EPS)) {
      win = WIN_SIZE;
      abs = sizeAbs;
      delta = sizeDelta;
      line = mask === 1 ? 0 : 2;
      axOwner[ax] = sizeOwner;
    }
  }
  if (wholeBox || mask === 1 || mask === 4) {
    probeGaps(index, ax, mask, wholeBox, threshold);
    if (gapFound && (win === WIN_NONE || gapAbs < abs - SNAP_EPS)) {
      win = WIN_GAP;
      abs = gapAbs;
      delta = gapDelta;
      line = gapLine;
      axGap[ax] = gapSize;
      axBefore[ax] = nbBefore;
      axAfter[ax] = nbAfter;
    }
  }

  // Hysteresis: the target this axis held on the previous call wins while it is within the release
  // distance, unless the fresh winner is clearly nearer.
  if (st !== null && st.win[ax] !== WIN_NONE && mask & LINE_BIT[st.line[ax]]) {
    const l = st.line[ax];
    const pos = l === 0 ? lo : l === 2 ? hi : (lo + hi) / 2;
    const sd = st.target[ax] - pos;
    const sabs = Math.abs(sd);
    if (
      sabs <= threshold * SNAP_RELEASE &&
      (win === WIN_NONE || abs > sabs - threshold * SNAP_SWITCH)
    ) {
      win = st.win[ax];
      delta = sd;
      line = l;
      axGap[ax] = st.gap[ax];
      axOwner[ax] = st.owner[ax];
      axBefore[ax] = st.before[ax];
      axAfter[ax] = st.after[ax];
    }
  }
  if (st !== null) {
    st.win[ax] = win;
    if (win !== WIN_NONE) {
      st.line[ax] = line;
      st.target[ax] = (line === 0 ? lo : line === 2 ? hi : (lo + hi) / 2) + delta;
      st.gap[ax] = axGap[ax];
      st.owner[ax] = axOwner[ax];
      st.before[ax] = axBefore[ax];
      st.after[ax] = axAfter[ax];
    }
  }

  axWin[ax] = win;
  axDelta[ax] = delta;
  axLine[ax] = line;
}

// The mask bit of each moving line (0: min edge, 1: centre, 2: max edge).
const LINE_BIT = [1, 2, 4] as const;

// What one result object remembers between calls of a drag (per axis: the winning family, moving
// line, the coordinate that line was snapped to, and the gap / size details its guides need). Keyed
// by the result object, and reset when the index changes (a new gesture builds a new index).
interface Sticky {
  index: SnapIndex;
  win: Uint8Array;
  line: Int8Array;
  target: Float64Array;
  gap: Float64Array;
  owner: Int32Array;
  before: Int32Array;
  after: Int32Array;
}

const stickies = new WeakMap<SnapResult, Sticky>();

function stickyFor(out: SnapResult, index: SnapIndex): Sticky {
  let st = stickies.get(out);
  if (!st) {
    st = {
      index,
      win: new Uint8Array(2),
      line: new Int8Array(2),
      target: new Float64Array(2),
      gap: new Float64Array(2),
      owner: new Int32Array(2),
      before: new Int32Array(2),
      after: new Int32Array(2),
    };
    stickies.set(out, st);
  } else if (st.index !== index) {
    st.index = index;
    st.win[0] = WIN_NONE;
    st.win[1] = WIN_NONE;
  }
  return st;
}

// Forget what `out` held (the next call snaps afresh): for a caller that skipped snapping for a while
// (the modifier that suspends it) and does not want the old target back.
export function resetSnapHysteresis(out: SnapResult): void {
  const st = stickies.get(out);
  if (st) {
    st.win[0] = WIN_NONE;
    st.win[1] = WIN_NONE;
  }
}

// Sorted, without near-duplicates (within SNAP_EPS), in place.
function uniqueSorted(v: number[]): number[] {
  v.sort((a, b) => a - b);
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    if (n === 0 || v[i] - v[n - 1] > SNAP_EPS) v[n++] = v[i];
  }
  v.length = n;
  return v;
}

// Add (or extend) the guide at `at`. Coincident moving lines (a zero-width box) and several matching
// candidates all collapse into one guide per (axis, position, kind), whose marks are merged.
function pushGuide(
  guides: Guide[],
  axis: 'x' | 'y',
  at: number,
  marks: number[],
  extend: number,
  kind: LineGuide['kind'],
): void {
  for (let i = 0; i < guides.length; i++) {
    const g = guides[i];
    if (g.axis === axis && g.kind === kind && Math.abs(g.at - at) <= SNAP_EPS) {
      const merged = uniqueSorted([...((g as LineGuide).marks ?? []), ...marks]);
      (g as LineGuide).marks = merged;
      g.from = Math.min(g.from, merged[0] - extend);
      g.to = Math.max(g.to, merged[merged.length - 1] + extend);
      return;
    }
  }
  uniqueSorted(marks);
  guides.push({
    axis,
    at,
    from: marks[0] - extend,
    to: marks[marks.length - 1] + extend,
    kind,
    marks,
  });
}

// Guides for one snapped moving line now sitting at `target`: the candidate lines within SNAP_EPS of
// it join the guide, the MAX_LINE_BOXES boxes nearest to the moving box. Each leaves its marks (both
// corners when aligned by an edge, the midpoint when aligned by its centre), and the span runs from the
// first mark to the last, plus `extend`. `sameLo` / `sameHi` (the
// moved box's extent across a centre line): a candidate aligned centre to centre with exactly that
// extent has both its edges on the box's edge lines, whose guides already show it, so it is left out
// (and the centre guide is dropped when nothing else is on it).
function addGuides(
  guides: Guide[],
  axis: 'x' | 'y',
  index: SnapIndex,
  lines: AxisLines,
  target: number,
  movingKind: number,
  perpLo: number,
  perpHi: number,
  extend: number,
  sameLo = NaN,
  sameHi = NaN,
): void {
  const v = lines.v;
  const boxes = index.boxes;
  // Along a vertical line the owners' extent is their y range, along a horizontal one their x range;
  // `ext*` is the extent across the line (to recognise a box of the moving box's size).
  const loOff = axis === 'x' ? 1 : 0;
  const hiOff = axis === 'x' ? 3 : 2;
  const extLoOff = axis === 'x' ? 0 : 1;
  const extHiOff = axis === 'x' ? 2 : 3;
  // The candidate boxes on the line, nearest to the moving box first (at most MAX_LINE_BOXES: on a
  // dense board a whole column lines up, and the far ones only add clutter).
  let kept = 0;
  const end = target + SNAP_EPS;
  for (let j = lowerBound(v, target - SNAP_EPS); j < v.length && v[j] <= end; j++) {
    const o = lines.owner[j] * 4;
    const lo = boxes[o + loOff];
    const hi = boxes[o + hiOff];
    const k = lines.kind[j];
    if (
      k === CENTER &&
      Math.abs(boxes[o + extLoOff] - sameLo) <= SNAP_EPS &&
      Math.abs(boxes[o + extHiOff] - sameHi) <= SNAP_EPS
    ) {
      continue;
    }
    const d = Math.max(0, lo - perpHi, perpLo - hi);
    let slot = kept;
    while (slot > 0 && lineD[slot - 1] > d) slot--;
    if (slot >= MAX_LINE_BOXES) continue;
    for (let q = Math.min(kept, MAX_LINE_BOXES - 1); q > slot; q--) {
      lineD[q] = lineD[q - 1];
      lineA[q] = lineA[q - 1];
      lineB[q] = lineB[q - 1];
    }
    lineD[slot] = d;
    // An edge match marks both corners; a centre match its midpoint (twice: one code path).
    lineA[slot] = k === CENTER ? (lo + hi) / 2 : lo;
    lineB[slot] = k === CENTER ? (lo + hi) / 2 : hi;
    if (kept < MAX_LINE_BOXES) kept++;
  }
  let main: number[] | null = null;
  if (kept > 0) {
    main = [];
    for (let q = 0; q < kept; q++) main.push(lineA[q], lineB[q]);
  }
  if (main === null) return;
  // The moving box's own marks.
  const ownLo = movingKind === CENTER ? (perpLo + perpHi) / 2 : perpLo;
  const ownHi = movingKind === CENTER ? ownLo : perpHi;
  main.push(ownLo, ownHi);
  pushGuide(guides, axis, target, main, extend, movingKind === CENTER ? 'center' : 'edge');
}

// At most this many candidate boxes are marked on one alignment guide (the nearest), and their scratch.
const MAX_LINE_BOXES = 6;
const lineD = new Float64Array(MAX_LINE_BOXES);
const lineA = new Float64Array(MAX_LINE_BOXES);
const lineB = new Float64Array(MAX_LINE_BOXES);

// Markers of a gap snap along `ax`, measured from the corrected box `fb`: the moving box's gap to each
// neighbour that now has the target size, then the existing gaps of that size on its row (at most
// MAX_REF_GAPS), which are the ones it was matched to.
function addGapGuides(guides: Guide[], index: SnapIndex, ax: number): void {
  const boxes = index.boxes;
  const pa = 1 - ax;
  const axis = AXES[ax];
  const size = axGap[ax];
  const label = Math.round(size);
  const m0 = fb[ax];
  const m1 = fb[ax + 2];
  const p0 = fb[pa];
  const p1 = fb[pa + 2];
  const before = axBefore[ax];
  const after = axAfter[ax];
  if (before >= 0) {
    const k = before * 4;
    const edge = boxes[k + ax + 2];
    if (Math.abs(m0 - edge - size) <= SNAP_EPS) {
      const at = (Math.max(boxes[k + pa], p0) + Math.min(boxes[k + pa + 2], p1)) / 2;
      guides.push({ axis, at, from: edge, to: m0, kind: 'gap', label });
    }
  }
  if (after >= 0) {
    const k = after * 4;
    const edge = boxes[k + ax];
    if (Math.abs(edge - m1 - size) <= SNAP_EPS) {
      const at = (Math.max(boxes[k + pa], p0) + Math.min(boxes[k + pa + 2], p1)) / 2;
      guides.push({ axis, at, from: m1, to: edge, kind: 'gap', label });
    }
  }
  const gl = ax === 0 ? index.gapsX : index.gapsY;
  const v = gl.v;
  // The matching gaps on the row nearest to the moving box (by the distance between centres along
  // the axis), at most MAX_REF_GAPS, kept sorted in a small insertion list.
  const mid = (m0 + m1) / 2;
  let kept = 0;
  let scanned = 0;
  for (
    let j = lowerBound(v, size - SNAP_EPS);
    j < v.length && v[j] <= size + SNAP_EPS && scanned < REF_GAP_SCAN;
    j++, scanned++
  ) {
    if (!gapInRow(index, gl, j, pa, p0, p1)) continue;
    const d = Math.abs((boxes[gl.before[j] * 4 + ax + 2] + boxes[gl.after[j] * 4 + ax]) / 2 - mid);
    let slot = kept;
    while (slot > 0 && refDist[slot - 1] > d) slot--;
    if (slot >= MAX_REF_GAPS) continue;
    for (let q = Math.min(kept, MAX_REF_GAPS - 1); q > slot; q--) {
      refDist[q] = refDist[q - 1];
      refIdx[q] = refIdx[q - 1];
    }
    refDist[slot] = d;
    refIdx[slot] = j;
    if (kept < MAX_REF_GAPS) kept++;
  }
  for (let r = 0; r < kept; r++) {
    const j = refIdx[r];
    const ka = gl.before[j] * 4;
    const kb = gl.after[j] * 4;
    const at =
      (Math.max(boxes[ka + pa], boxes[kb + pa]) +
        Math.min(boxes[ka + pa + 2], boxes[kb + pa + 2])) /
      2;
    guides.push({
      axis,
      at,
      from: boxes[ka + ax + 2],
      to: boxes[kb + ax],
      kind: 'gap',
      label,
    });
  }
}

// Scratch of `addGapGuides`: the nearest reference gaps so far.
const refDist = new Float64Array(MAX_REF_GAPS);
const refIdx = new Int32Array(MAX_REF_GAPS);

// One extent marker across the middle of box `o` (the resized box itself when `o` is -1).
function pushSizeGuide(
  guides: Guide[],
  index: SnapIndex,
  ax: number,
  o: number,
  label: number,
): void {
  const pa = 1 - ax;
  let lo: number;
  let hi: number;
  let plo: number;
  let phi: number;
  if (o < 0) {
    lo = fb[ax];
    hi = fb[ax + 2];
    plo = fb[pa];
    phi = fb[pa + 2];
  } else {
    const k = o * 4;
    lo = index.boxes[k + ax];
    hi = index.boxes[k + ax + 2];
    plo = index.boxes[k + pa];
    phi = index.boxes[k + pa + 2];
  }
  guides.push({ axis: AXES[ax], at: (plo + phi) / 2, from: lo, to: hi, kind: 'width', label });
}

// Markers of a size match along `ax`: the corrected box `fb` and the box it matched, plus any other
// nearby boxes of that exact extent (up to MAX_SIZE_MATCHES boxes in all).
function addSizeGuides(guides: Guide[], index: SnapIndex, ax: number): void {
  const size = fb[ax + 2] - fb[ax];
  const label = Math.round(size);
  const winner = axOwner[ax];
  pushSizeGuide(guides, index, ax, -1, label);
  pushSizeGuide(guides, index, ax, winner, label);
  const sizes = ax === 0 ? index.widths : index.heights;
  const v = sizes.v;
  const pa = 1 - ax;
  let matched = 1;
  for (
    let j = lowerBound(v, size - SNAP_EPS);
    j < v.length && v[j] <= size + SNAP_EPS && matched < MAX_SIZE_MATCHES;
    j++
  ) {
    const o = sizes.owner[j];
    if (o === winner) continue;
    if (!nearbyForSize(index.boxes, o, ax, fb[ax], fb[ax + 2], fb[pa], fb[pa + 2])) continue;
    pushSizeGuide(guides, index, ax, o, label);
    matched++;
  }
}

function newResult(): SnapResult {
  return { dx: 0, dy: 0, guides: [] };
}

// Shared by move and resize. `maskX` / `maskY` select which moving lines may snap on each axis
// (bit 0: min edge, bit 1: centre, bit 2: max edge). A move uses all three; a resize only the
// dragged edges. The winning line of each axis is shifted by its correction, which decides the final
// box the guides are measured from: a move shifts the whole box, a resize only the dragged edge.
function snap(
  index: SnapIndex,
  moving: Box,
  maskX: number,
  maskY: number,
  wholeBox: boolean,
  threshold: number,
  extend: number,
  out: SnapResult,
): SnapResult {
  out.dx = 0;
  out.dy = 0;
  out.edgeX = undefined;
  out.edgeY = undefined;
  out.guides.length = 0;
  if (!(threshold > 0) || index.count === 0 || (maskX === 0 && maskY === 0)) return out;

  mv[0] = moving.minX;
  mv[1] = moving.minY;
  mv[2] = moving.maxX;
  mv[3] = moving.maxY;
  axWin[0] = WIN_NONE;
  axWin[1] = WIN_NONE;
  const st = stickyFor(out, index);
  if (maskX !== 0) snapAxis(index, 0, maskX, wholeBox, threshold, st);
  else st.win[0] = WIN_NONE;
  if (maskY !== 0) snapAxis(index, 1, maskY, wholeBox, threshold, st);
  else st.win[1] = WIN_NONE;
  const winX = axWin[0];
  const winY = axWin[1];
  if (winX === WIN_NONE && winY === WIN_NONE) return out;

  // The box after the correction: the guides are measured against it.
  const lineX = winX !== WIN_NONE ? axLine[0] : -1;
  const lineY = winY !== WIN_NONE ? axLine[1] : -1;
  const dx = winX !== WIN_NONE ? axDelta[0] : 0;
  const dy = winY !== WIN_NONE ? axDelta[1] : 0;
  out.dx = dx;
  out.dy = dy;
  if (!wholeBox) {
    if (lineX >= 0) out.edgeX = lineX === 0 ? 'min' : 'max';
    if (lineY >= 0) out.edgeY = lineY === 0 ? 'min' : 'max';
  }
  const shiftMinX = lineX >= 0 && (wholeBox || lineX === 0);
  const shiftMaxX = lineX >= 0 && (wholeBox || lineX === 2);
  const shiftMinY = lineY >= 0 && (wholeBox || lineY === 0);
  const shiftMaxY = lineY >= 0 && (wholeBox || lineY === 2);
  const minX = shiftMinX ? moving.minX + dx : moving.minX;
  const maxX = shiftMaxX ? moving.maxX + dx : moving.maxX;
  const minY = shiftMinY ? moving.minY + dy : moving.minY;
  const maxY = shiftMaxY ? moving.maxY + dy : moving.maxY;
  const guides = out.guides;

  // Alignment guides for whatever ended up on a line, whichever family won the axis.
  if (lineX >= 0) {
    if (wholeBox) {
      addGuides(guides, 'x', index, index.x, minX, EDGE, minY, maxY, extend);
      addGuides(guides, 'x', index, index.x, maxX, EDGE, minY, maxY, extend);
      const cx = (minX + maxX) / 2;
      addGuides(guides, 'x', index, index.x, cx, CENTER, minY, maxY, extend, minX, maxX);
    } else {
      const at = lineX === 0 ? minX : maxX;
      addGuides(guides, 'x', index, index.x, at, EDGE, minY, maxY, extend);
    }
  }
  if (lineY >= 0) {
    if (wholeBox) {
      addGuides(guides, 'y', index, index.y, minY, EDGE, minX, maxX, extend);
      addGuides(guides, 'y', index, index.y, maxY, EDGE, minX, maxX, extend);
      const cy = (minY + maxY) / 2;
      addGuides(guides, 'y', index, index.y, cy, CENTER, minX, maxX, extend, minY, maxY);
    } else {
      const at = lineY === 0 ? minY : maxY;
      addGuides(guides, 'y', index, index.y, at, EDGE, minX, maxX, extend);
    }
  }

  if (winX === WIN_GAP || winX === WIN_SIZE || winY === WIN_GAP || winY === WIN_SIZE) {
    fb[0] = minX;
    fb[1] = minY;
    fb[2] = maxX;
    fb[3] = maxY;
    if (winX === WIN_GAP) addGapGuides(guides, index, 0);
    else if (winX === WIN_SIZE) addSizeGuides(guides, index, 0);
    if (winY === WIN_GAP) addGapGuides(guides, index, 1);
    else if (winY === WIN_SIZE) addSizeGuides(guides, index, 1);
  }
  return out;
}

// Moving a whole box (a card, or a multi-selection's union). The smallest |delta| within
// `thresholdWorld` wins over the three lines of each axis and the gap snaps; ties prefer
// centre-to-centre, then edge-to-edge, and an alignment over a gap. Pass `out`
// to reuse one result object across a drag.
export function snapMove(
  index: SnapIndex,
  moving: Box,
  thresholdWorld: number,
  extendWorld: number,
  out: SnapResult = newResult(),
): SnapResult {
  return snap(index, moving, 7, 7, true, thresholdWorld, extendWorld, out);
}

// Resizing: only the dragged edges snap (a centre moves with the box, so it never does), to lines, to
// the box's width / height matching a nearby box's, and to equal gaps next to the dragged edge. The
// correction applies to the dragged edge's coordinate: `dx` to the left or right edge, `dy` to the
// top or bottom one. If both opposite edges of an axis are flagged (a symmetric resize), only the
// nearer one snaps to a line and sizes and gaps are skipped; `edgeX` / `edgeY` then say which edge the
// correction belongs to.
export function snapResize(
  index: SnapIndex,
  moving: Box,
  edges: ResizeEdges,
  thresholdWorld: number,
  extendWorld: number,
  out: SnapResult = newResult(),
): SnapResult {
  const maskX = (edges.left ? 1 : 0) | (edges.right ? 4 : 0);
  const maskY = (edges.top ? 1 : 0) | (edges.bottom ? 4 : 0);
  return snap(index, moving, maskX, maskY, false, thresholdWorld, extendWorld, out);
}
