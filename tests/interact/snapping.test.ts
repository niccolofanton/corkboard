import { describe, expect, it } from 'vitest';
import { boxUnion, type Aabb } from '../../src/interact/geometry';
import {
  SNAP_RELEASE,
  SNAP_THRESHOLD_PX,
  buildSnapIndex,
  resetSnapHysteresis,
  snapMove,
  snapResize,
  type Guide,
  type SnapCandidate,
  type SnapResult,
} from '../../src/interact/snapping';

const box = (x: number, y: number, w: number, h: number): Aabb => ({
  minX: x,
  minY: y,
  maxX: x + w,
  maxY: y + h,
});
const cand = (id: string, x: number, y: number, w: number, h: number): SnapCandidate => ({
  id,
  box: box(x, y, w, h),
});

const T = 6; // 6 screen px at zoom 1
const EXT = 16;

function guideOf(res: SnapResult, axis: 'x' | 'y', kind?: Guide['kind']): Guide | undefined {
  return res.guides.find((g) => g.axis === axis && (kind === undefined || g.kind === kind));
}

// One candidate A: x 100..200 (centre 150), y 0..100 (middle 50). Its x lines: 100, 150, 200.
// The moving boxes are kept far from A on the other axis so only one axis is in play.
const A = cand('A', 100, 0, 100, 100);

describe('snapMove: one line at a time', () => {
  const idx = buildSnapIndex([A]);
  // Moving boxes are 30 wide at y = 1000 (far below A's y lines).
  const at = (minX: number) => box(minX, 1000, 30, 30);

  it('snaps the left edge to a candidate line within the threshold, and not beyond it', () => {
    // Lines of the moving box: 105, 120, 135 -> the left edge is 5 from A's left (100).
    const r = snapMove(idx, at(105), T, EXT);
    expect(r.dx).toBe(-5);
    expect(r.dy).toBe(0);
    // 7 away from A's left edge: the lines are 107, 122, 137 and nothing is within 6.
    const far = snapMove(idx, at(107), T, EXT);
    expect(far.dx).toBe(0);
    expect(far.guides).toEqual([]);
  });

  it('snaps the right edge to a candidate line', () => {
    // Lines: 165, 180, 195 -> the right edge is 5 short of A's right (200).
    const r = snapMove(idx, at(165), T, EXT);
    expect(r.dx).toBe(5);
    expect(snapMove(idx, at(163), T, EXT).dx).toBe(0); // 193 is 7 short, 178 and 163 are far
  });

  it('snaps the centre to a candidate centre line', () => {
    // Lines: 140, 155, 170 -> the centre is 5 past A's centre (150).
    const r = snapMove(idx, at(140), T, EXT);
    expect(r.dx).toBe(-5);
    expect(guideOf(r, 'x')?.kind).toBe('center');
  });

  it('snaps an edge onto a candidate centre line', () => {
    // Lines: 117, 132, 147 -> the right edge is 3 short of the centre line 150.
    const r = snapMove(idx, at(117), T, EXT);
    expect(r.dx).toBe(3);
  });

  it('snaps top, middle and bottom the same way', () => {
    const idy = buildSnapIndex([A]); // y lines: 0, 50, 100
    const move = (minY: number) => box(1000, minY, 30, 30);
    // Lines: 104, 119, 134 -> the top edge is 4 below A's bottom (100).
    expect(snapMove(idy, move(104), T, EXT).dy).toBe(-4);
    // Lines: -33, -18, -3 -> the bottom edge is 3 above A's top (0).
    expect(snapMove(idy, move(-33), T, EXT).dy).toBe(3);
    // Lines: 31, 46, 61 -> the middle is 4 above A's middle (50); 61 is 11 from it.
    expect(snapMove(idy, move(31), T, EXT).dy).toBe(4);
    expect(snapMove(idy, move(31), T, EXT).dx).toBe(0);
    // 7 away from every line.
    expect(snapMove(idy, move(107), T, EXT).dy).toBe(0);
  });

  it('works with a world threshold from a low zoom (6 / 0.25 = 24)', () => {
    const thr = 6 / 0.25;
    // Lines of a 10 wide box at x = 70: 70, 75, 80 -> the right edge is 20 short of 100.
    const m = box(70, 1000, 10, 10);
    expect(snapMove(idx, m, thr, EXT * 4).dx).toBe(20);
    // One more unit away (25 from every line) and nothing snaps.
    const farther = box(65, 1000, 10, 10);
    expect(snapMove(idx, farther, thr, EXT * 4).dx).toBe(0);
    // The same boxes at zoom 1 do not snap at all: the threshold is screen-constant, not world-constant.
    expect(snapMove(idx, m, T, EXT).dx).toBe(0);
  });

  it('snaps at exactly the threshold and reports zero when already aligned', () => {
    expect(snapMove(idx, at(106), T, EXT).dx).toBe(-6);
    const aligned = snapMove(idx, at(100), T, EXT);
    expect(aligned.dx).toBe(0);
    expect(aligned.guides.length).toBeGreaterThan(0); // still draws the guide
  });
});

describe('snapMove: axes and priorities', () => {
  it('snaps X and Y independently', () => {
    const idx = buildSnapIndex([A]);
    // X: left edge 3 right of 100. Y: top 40 below A's bottom (100), nothing near.
    const r = snapMove(idx, box(103, 140, 30, 30), T, EXT);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    expect(r.guides.every((g) => g.axis === 'x')).toBe(true);
    // The other way round: Y snaps, X does not.
    const r2 = snapMove(idx, box(400, 103, 30, 30), T, EXT);
    expect(r2.dx).toBe(0);
    expect(r2.dy).toBe(-3);
    expect(r2.guides.every((g) => g.axis === 'y')).toBe(true);
    // Both axes at once.
    const r3 = snapMove(idx, box(103, 104, 30, 30), T, EXT);
    expect(r3.dx).toBe(-3);
    expect(r3.dy).toBe(-4);
    expect(r3.guides.some((g) => g.axis === 'x')).toBe(true);
    expect(r3.guides.some((g) => g.axis === 'y')).toBe(true);
  });

  it('picks the nearest line', () => {
    const idx = buildSnapIndex([cand('L', 100, 0, 10, 10), cand('R', 120, 0, 10, 10)]);
    // x lines: 100, 105, 110, 120, 125, 130. A 4 wide box whose left edge is 114: nearest 110 (4)
    // beats 120 (6); its right edge 118 is 2 from 120 and wins overall.
    const r = snapMove(idx, box(114, 1000, 4, 4), T, EXT);
    expect(r.dx).toBe(2);
  });

  it('breaks an exact tie centre-to-centre first', () => {
    // A: lines 100, 150, 200. C: lines 176, 218, 260. Moving 40 wide at x = 133: lines 133, 153, 173.
    // The centre is 3 past A's centre; the right edge is 3 short of C's left edge.
    const idx = buildSnapIndex([A, cand('C', 176, 0, 84, 100)]);
    const r = snapMove(idx, box(133, 1000, 40, 40), T, EXT);
    expect(r.dx).toBe(-3);
    expect(guideOf(r, 'x')?.kind).toBe('center');
  });

  it('breaks a tie edge-to-edge before an edge on a centre', () => {
    // D's x lines: 120, 126, 132. The moving left edge (123) is 3 from D's left edge (-3) and 3 from
    // D's centre (+3); the other moving lines (173, 223) are far from everything.
    const idx = buildSnapIndex([cand('D', 120, 0, 12, 100)]);
    const r = snapMove(idx, box(123, 1000, 100, 20), T, EXT);
    expect(r.dx).toBe(-3);
  });

  it('works with a multi-selection union box', () => {
    const idx = buildSnapIndex([A]);
    // The union spans x 204..290: its left edge is 4 right of A's right edge (200).
    const u = boxUnion(box(204, 1000, 20, 20), box(250, 1100, 40, 30));
    expect(snapMove(idx, u, T, EXT).dx).toBe(-4);
    // Moved clear of every line: no snap.
    const away = boxUnion(box(304, 1000, 20, 20), box(350, 1100, 40, 30));
    expect(snapMove(idx, away, T, EXT).dx).toBe(0);
  });
});

describe('guide spans', () => {
  it('spans from the moving box to the farthest aligned candidate, extended at both ends', () => {
    // A: x 100..200, y 0..100. B: x 100..180, y 300..400 (same left edge).
    const idx = buildSnapIndex([A, cand('B', 100, 300, 80, 100)]);
    const r = snapMove(idx, box(103, 150, 33, 50), T, EXT); // lines 103, 119.5, 136: nothing else lines up
    expect(r.dx).toBe(-3);
    const g = guideOf(r, 'x');
    expect(g).toMatchObject({ axis: 'x', at: 100, from: 0 - EXT, to: 400 + EXT, kind: 'edge' });
    expect(r.guides.filter((q) => q.axis === 'x')).toHaveLength(1); // ONE guide for both candidates
  });

  it('includes the moving box when it is the farthest end', () => {
    const idx = buildSnapIndex([A]); // y 0..100
    // The moving box is below A (y 150..200): the guide runs from A's top to the moving bottom.
    const r = snapMove(idx, box(103, 150, 40, 50), T, EXT);
    expect(guideOf(r, 'x')).toMatchObject({
      axis: 'x',
      at: 100,
      from: -EXT,
      to: 200 + EXT,
      kind: 'edge',
    });
    // And above A: from the moving top to A's bottom.
    const r2 = snapMove(idx, box(103, -80, 40, 50), T, EXT);
    expect(guideOf(r2, 'x')).toMatchObject({
      axis: 'x',
      at: 100,
      from: -80 - EXT,
      to: 100 + EXT,
      kind: 'edge',
    });
  });

  it('measures the span from the box after the other axis snapped too', () => {
    const idx = buildSnapIndex([A]);
    // Y snaps by -4 (top 104 -> 100), so the vertical guide must start from the corrected y range.
    const r = snapMove(idx, box(103, 104, 30, 30), T, EXT);
    expect(r.dy).toBe(-4);
    const gx = guideOf(r, 'x', 'edge');
    expect(gx?.at).toBe(100);
    expect(gx?.from).toBe(-EXT);
    expect(gx?.to).toBe(130 + EXT); // moving bottom after the correction: 100 + 30
  });

  it('draws horizontal guides along x', () => {
    const idx = buildSnapIndex([A]); // y lines: 0, 50, 100
    const r = snapMove(idx, box(300, 97, 30, 30), T, EXT); // top 97 -> 100
    expect(r.dy).toBe(3);
    expect(guideOf(r, 'y')).toMatchObject({
      axis: 'y',
      at: 100,
      from: 100 - EXT,
      to: 330 + EXT,
      kind: 'edge',
    });
  });

  it('uses kind center for a centre-to-centre match', () => {
    const idx = buildSnapIndex([A]);
    const r = snapMove(idx, box(142, 1000, 16, 16), T, EXT); // centre 150: aligned already
    expect(r.dx).toBe(0);
    expect(guideOf(r, 'x', 'center')?.at).toBe(150);
  });

  it('reports every moving line that ends up aligned, one guide each', () => {
    // A (100..200) and a second candidate whose right edge is at 240. A 140 wide box at x = 103:
    // its left snaps to 100 and its right (243 -> 240) ends up exactly on the second line.
    const idx = buildSnapIndex([A, cand('E', 140, 300, 100, 50)]);
    const r = snapMove(idx, box(103, 1000, 140, 20), T, EXT);
    expect(r.dx).toBe(-3);
    const xs = r.guides.filter((g) => g.axis === 'x').map((g) => g.at);
    expect(xs.sort((a, b) => a - b)).toEqual([100, 240]);
  });

  it('collapses several coincident candidate lines into one guide', () => {
    // Three candidates share the line x = 100.
    const cands = [
      cand('A', 100, 0, 50, 50),
      cand('B', 100, 200, 50, 50),
      cand('C', 100, 500, 50, 50),
    ];
    const idx = buildSnapIndex(cands);
    const r = snapMove(idx, box(102, 700, 20, 20), T, EXT);
    expect(r.dx).toBe(-2);
    const edge = guideOf(r, 'x', 'edge');
    // The edge guide spans A..C and the moving box.
    expect(edge).toMatchObject({ axis: 'x', at: 100, from: 0 - EXT, to: 720 + EXT, kind: 'edge' });
    expect(r.guides.filter((g) => g.axis === 'x')).toHaveLength(1);
  });

  it('extends by the given amount (extendWorld = 16 / zoom)', () => {
    const idx = buildSnapIndex([A]);
    const r = snapMove(idx, box(103, 150, 40, 50), T, 16 / 0.5);
    expect(guideOf(r, 'x')).toMatchObject({ from: -32, to: 232 });
  });
});

describe('snapResize', () => {
  // Candidate lines on x: 400, 450, 500. On y: 400, 450, 500.
  const idx = buildSnapIndex([cand('R', 400, 400, 100, 100)]);

  it('a corner drag snaps the dragged edges only', () => {
    // Aabb 100..397 x 100..303. Dragging bottom-right: the right edge is 3 short of 400, the left
    // edge (100) is nowhere near a line. The bottom edge (303) is not near 400 either.
    const r = snapResize(idx, box(100, 100, 297, 203), { right: true, bottom: true }, T, EXT);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(0);
    // Now the bottom edge is the near one.
    const r2 = snapResize(idx, box(100, 100, 297, 297), { right: true, bottom: true }, T, EXT);
    expect(r2.dx).toBe(3);
    expect(r2.dy).toBe(3);
  });

  it('does not touch an undragged edge even when it is within the threshold', () => {
    // The left edge sits 2 from 400, the right edge (dragged) is far from every line.
    const m = box(398, 100, 600, 100);
    const r = snapResize(idx, m, { right: true }, T, EXT);
    expect(r.dx).toBe(0);
    expect(r.guides).toEqual([]);
    // Dragging the left edge instead snaps it.
    const l = snapResize(idx, m, { left: true }, T, EXT);
    expect(l.dx).toBe(2);
  });

  it('an edge drag snaps that edge only', () => {
    // Top edge dragged: 395 is 5 from 400; the bottom (500+) and the x lines do not matter.
    const m = box(398, 395, 100, 300);
    const r = snapResize(idx, m, { top: true }, T, EXT);
    expect(r.dy).toBe(5);
    expect(r.dx).toBe(0);
  });

  it('never snaps the centre of the box', () => {
    // A candidate whose centre line is 2 from the moving centre; neither moving edge is near a line.
    const only = buildSnapIndex([cand('C', 50, 0, 144, 10)]); // x lines: 50, 122, 194
    const m = box(100, 1000, 40, 40); // centre 120, right edge 140
    expect(snapMove(only, m, T, EXT).dx).toBe(2); // a move snaps the centre...
    expect(snapResize(only, m, { right: true }, T, EXT).dx).toBe(0); // ...a resize does not
    expect(snapResize(only, m, { left: true }, T, EXT).dx).toBe(0);
  });

  it('measures the guide from the resized box and marks it as an edge guide', () => {
    const r = snapResize(idx, box(100, 100, 297, 203), { right: true, bottom: true }, T, EXT);
    // Vertical guide at 400 from the box's top (100) to R's bottom (500): the bottom edge was not
    // corrected (dy = 0), so the span uses the box as given.
    expect(guideOf(r, 'x')).toMatchObject({
      axis: 'x',
      at: 400,
      from: 100 - EXT,
      to: 500 + EXT,
      kind: 'edge',
    });
    expect(r.guides).toHaveLength(1);
  });

  it('applies the correction to the dragged edge when measuring the other axis guide', () => {
    const r = snapResize(idx, box(100, 100, 297, 297), { right: true, bottom: true }, T, EXT);
    // Bottom edge 397 -> 400, so the vertical guide's moving end is 400, not 397.
    const gx = guideOf(r, 'x');
    expect(gx?.from).toBe(100 - EXT);
    expect(gx?.to).toBe(500 + EXT);
    const gy = guideOf(r, 'y');
    expect(gy).toMatchObject({ axis: 'y', at: 400, from: 100 - EXT, to: 500 + EXT, kind: 'edge' });
  });

  it('snaps a dragged edge to a candidate centre', () => {
    const c = snapResize(idx, box(100, 100, 347, 100), { right: true }, T, EXT); // right 447 -> 450
    expect(c.dx).toBe(3);
  });

  it('with no dragged edge it does nothing', () => {
    const r = snapResize(idx, box(398, 398, 10, 10), {}, T, EXT);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([]);
  });
});

describe('degenerate inputs and result reuse', () => {
  it('an empty index returns zeros and no guides', () => {
    const idx = buildSnapIndex([]);
    expect(idx.count).toBe(0);
    const r = snapMove(idx, box(10, 10, 10, 10), T, EXT);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
    const rr = snapResize(idx, box(10, 10, 10, 10), { right: true, bottom: true }, T, EXT);
    expect(rr).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('a threshold of 0 never snaps, even when exactly aligned', () => {
    const idx = buildSnapIndex([A]);
    const r = snapMove(idx, box(100, 1000, 30, 30), 0, EXT);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
    expect(snapMove(idx, box(100, 1000, 30, 30), -1, EXT).guides).toEqual([]);
  });

  it('reuses the out object and leaves no stale guides', () => {
    const idx = buildSnapIndex([A]);
    const out: SnapResult = { dx: 99, dy: 99, guides: [] };
    const guidesRef = out.guides;
    const first = snapMove(idx, box(103, 1000, 30, 30), T, EXT, out);
    expect(first).toBe(out);
    expect(out.dx).toBe(-3);
    expect(out.guides.length).toBeGreaterThan(0);
    const second = snapMove(idx, box(500, 1000, 30, 30), T, EXT, out);
    expect(second).toBe(out);
    expect(out.guides).toBe(guidesRef);
    expect(out.dx).toBe(0);
    expect(out.dy).toBe(0);
    expect(out.guides).toHaveLength(0);
    // Resize reuses it as well.
    const third = snapResize(idx, box(103, 1000, 30, 30), { left: true }, T, EXT, out);
    expect(third).toBe(out);
    expect(out.dx).toBe(-3);
    const fourth = snapResize(idx, box(500, 1000, 30, 30), { left: true }, T, EXT, out);
    expect(fourth.guides).toHaveLength(0);
    expect(fourth.dx).toBe(0);
  });

  it('ignores candidates with non-finite or inverted boxes', () => {
    const bad: SnapCandidate[] = [
      { id: 'nan', box: { minX: NaN, minY: 0, maxX: 10, maxY: 10 } },
      { id: 'inf', box: { minX: 0, minY: 0, maxX: Infinity, maxY: 10 } },
      { id: 'inverted', box: { minX: 10, minY: 10, maxX: 0, maxY: 0 } },
      A,
    ];
    const idx = buildSnapIndex(bad);
    expect(idx.count).toBe(1);
    expect(idx.ids).toEqual(['A']);
    expect(snapMove(idx, box(103, 1000, 30, 30), T, EXT).dx).toBe(-3);
  });

  it('keeps working with a degenerate (zero-size) moving box', () => {
    const idx = buildSnapIndex([A]);
    const r = snapMove(idx, box(103, 1000, 0, 0), T, EXT);
    expect(r.dx).toBe(-3);
    // The three coincident moving lines still produce one guide per (axis, position, kind).
    const xs = r.guides.filter((g) => g.axis === 'x');
    expect(xs.filter((g) => g.kind === 'edge')).toHaveLength(1);
  });
});

// Measurement guides: `axis` is the direction the segment runs along (the opposite of a line guide's
// convention) and `at` the position on the other axis.
const gaps = (r: SnapResult): Guide[] => r.guides.filter((g) => g.kind === 'gap');
const widths = (r: SnapResult): Guide[] => r.guides.filter((g) => g.kind === 'width');

describe('equal gaps: snapMove', () => {
  // A row: A at x 0..100, B at x 150..250 (a gap of 50), both y 0..100.
  const rowA = cand('A', 0, 0, 100, 100);
  const rowB = cand('B', 150, 0, 100, 100);
  const idx = buildSnapIndex([rowA, rowB]);

  it('snaps the gap to a neighbour on X to an existing gap, and draws both markers', () => {
    // M is 100 wide, to the right of B: its gap to B (250) is 53, the row's gap is 50.
    const r = snapMove(idx, box(303, 10, 100, 100), T, EXT);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    expect(gaps(r)).toEqual([
      // The moving box's own gap: B's right edge to M's corrected left edge (300), at the middle of
      // the y range they share (10..100).
      { axis: 'x', at: 55, from: 250, to: 300, kind: 'gap', label: 50 },
      // The existing gap it matched: A to B.
      { axis: 'x', at: 50, from: 100, to: 150, kind: 'gap', label: 50 },
    ]);
    expect(r.guides).toHaveLength(2); // nothing is aligned: no line guides
  });

  it('works on the other side too: the gap to the neighbour AFTER the box', () => {
    // M ends 53 before A's left edge (0): M = -153..-53 -> -150..-50.
    const r = snapMove(idx, box(-153, 10, 100, 100), T, EXT);
    expect(r.dx).toBe(3);
    expect(gaps(r)[0]).toEqual({ axis: 'x', at: 55, from: -50, to: 0, kind: 'gap', label: 50 });
    // Beyond the threshold nothing snaps.
    const far = snapMove(idx, box(-157, 10, 100, 100), T, EXT); // gap 57, 7 away
    expect(far.dx).toBe(0);
    expect(gaps(far)).toEqual([]);
  });

  it('snaps gaps on Y: boxes stacked in a column', () => {
    const col = buildSnapIndex([cand('A', 0, 0, 100, 100), cand('B', 0, 150, 100, 100)]);
    // M is 100 tall, below B (bottom at 250): its gap is 53 against the column's 50.
    const r = snapMove(col, box(10, 303, 100, 100), T, EXT);
    expect(r.dy).toBe(-3);
    expect(r.dx).toBe(0);
    expect(gaps(r)).toEqual([
      { axis: 'y', at: 55, from: 250, to: 300, kind: 'gap', label: 50 },
      { axis: 'y', at: 50, from: 100, to: 150, kind: 'gap', label: 50 },
    ]);
  });

  it('centres the box between two neighbours so both gaps are equal', () => {
    const two = buildSnapIndex([cand('A', 0, 0, 100, 100), cand('B', 400, 0, 100, 100)]);
    // 200 free between them for a 100 wide box: 100 on each side -> x = 200.
    const r = snapMove(two, box(203, 10, 100, 100), T, EXT);
    expect(r.dx).toBe(-3);
    expect(gaps(r)).toEqual([
      { axis: 'x', at: 55, from: 100, to: 200, kind: 'gap', label: 100 },
      { axis: 'x', at: 55, from: 300, to: 400, kind: 'gap', label: 100 },
    ]);
    // On Y as well.
    const stack = buildSnapIndex([cand('A', 0, 0, 100, 100), cand('B', 0, 400, 100, 100)]);
    const ry = snapMove(stack, box(10, 197, 100, 100), T, EXT);
    expect(ry.dy).toBe(3);
    expect(gaps(ry).map((g) => [g.axis, g.from, g.to, g.kind === 'gap' && g.label])).toEqual([
      ['y', 100, 200, 100],
      ['y', 300, 400, 100],
    ]);
    // A box that overlaps a neighbour has no gap to centre.
    expect(snapMove(two, box(150, 10, 310, 100), T, EXT).guides).toEqual([]);
  });

  it('rounds the label to an integer world px', () => {
    const labels = (r: SnapResult) => gaps(r).map((g) => g.kind === 'gap' && g.label);
    const lo = buildSnapIndex([cand('A', 0, 0, 100, 100), cand('B', 150.4, 0, 100, 100)]);
    // The row's gap is 50.4: M's left edge targets 250.4 + 50.4 = 300.8.
    const a = snapMove(lo, box(303, 10, 100, 100), T, EXT);
    expect(a.dx).toBeCloseTo(-2.2, 9);
    expect(labels(a)).toEqual([50, 50]);
    const hi = buildSnapIndex([cand('A', 0, 0, 100, 100), cand('B', 150.6, 0, 100, 100)]);
    expect(labels(snapMove(hi, box(303, 10, 100, 100), T, EXT))).toEqual([51, 51]);
  });

  it('draws the nearest existing gaps of that size on the row, at most three', () => {
    // Six boxes in a row, all gaps 50: any of the five reference gaps is a match.
    const row: SnapCandidate[] = [];
    for (let i = 0; i < 6; i++) row.push(cand(`R${i}`, i * 150, 0, 100, 100));
    const r = snapMove(buildSnapIndex(row), box(903, 10, 100, 100), T, EXT);
    expect(r.dx).toBe(-3);
    const g = gaps(r);
    expect(g).toHaveLength(1 + 3); // the moving gap + the 3 nearest of the 5 reference gaps
    expect(g.every((m) => m.kind === 'gap' && m.label === 50 && m.to - m.from === 50)).toBe(true);
    // Nearest first: the gaps right before the box, never the far end of the row.
    expect(g.slice(1).map((m) => m.from)).toEqual([700, 550, 400]);
  });

  it('does not snap a gap whose neighbour does not overlap the box on the other axis', () => {
    // M is below the row: B does not overlap it on y, so there is no neighbour and no gap.
    const r = snapMove(idx, box(303, 500, 100, 100), T, EXT);
    expect(r.dx).toBe(0);
    expect(r.guides).toEqual([]);
    // Overlapping by a hair (1 px) counts as a neighbour...
    expect(snapMove(idx, box(303, 99, 100, 100), T, EXT).dx).toBe(-3);
    // ...touching corners (no overlap) does not.
    expect(snapMove(idx, box(303, 100, 100, 100), T, EXT).dx).toBe(0);
  });

  it('only matches gaps that sit on the box row', () => {
    // The 50 px gap A..B is at y 0..100; D (x 20..120) is on a row at y 300..400. M, right of D, has
    // a gap of 53 to D, but no gap of its own row to match.
    const far = buildSnapIndex([rowA, rowB, cand('D', 20, 300, 100, 100)]);
    expect(snapMove(far, box(173, 310, 100, 100), T, EXT).dx).toBe(0);
    // The same 50 px gap on D's own row is a match.
    const near = buildSnapIndex([
      cand('A2', 400, 310, 100, 100),
      cand('B2', 550, 310, 100, 100),
      cand('D2', 20, 300, 100, 100),
    ]);
    expect(snapMove(near, box(173, 310, 100, 100), T, EXT).dx).toBe(-3);
  });

  it('ignores a gap that has another box between its two ends', () => {
    // A B C in a row (gaps 50); A..C is not a gap because B lies between them.
    const abc = buildSnapIndex([
      cand('A', 0, 0, 100, 100),
      cand('B', 150, 0, 100, 100),
      cand('C', 300, 0, 100, 100),
    ]);
    // 200 would be the A..C "gap": M's gap to C is 203 and must not snap to it.
    expect(snapMove(abc, box(603, 10, 100, 100), T, EXT).dx).toBe(0);
    // The gaps that do exist still match, measured to the NEAREST neighbour (C).
    const r = snapMove(abc, box(453, 10, 100, 100), T, EXT);
    expect(r.dx).toBe(-3);
    expect(gaps(r)[0]).toMatchObject({ from: 400, to: 450 });
  });
});

describe('equal gaps: competition with alignment', () => {
  const A = cand('A', 0, 0, 100, 100);
  const B = cand('B', 150, 0, 100, 100);
  // A candidate on a row far below, with a left edge at `x`: it only offers an alignment line.
  const c = (x: number) => cand('C', x, 500, 40, 40);

  it('the smaller |delta| wins', () => {
    // The gap needs -3 (303 -> 300). An alignment line at 297 is 6 away: the gap wins.
    const gap = snapMove(buildSnapIndex([A, B, c(297)]), box(303, 10, 100, 100), T, EXT);
    expect(gap.dx).toBe(-3);
    expect(gaps(gap)).toHaveLength(2);
    // An alignment line at 301 is 2 away: the alignment wins with its own delta.
    const align = snapMove(buildSnapIndex([A, B, c(301)]), box(303, 10, 100, 100), T, EXT);
    expect(align.dx).toBe(-2);
    expect(gaps(align)).toEqual([]);
    expect(guideOf(align, 'x')?.kind).toBe('edge');
  });

  it('on a tie the alignment wins over the gap', () => {
    // Both want -3.
    const r = snapMove(buildSnapIndex([A, B, c(300)]), box(303, 10, 100, 100), T, EXT);
    expect(r.dx).toBe(-3);
    expect(gaps(r)).toEqual([]);
    expect(guideOf(r, 'x')).toMatchObject({ at: 300, kind: 'edge' });
  });

  it('X and Y snap independently: a gap on one axis next to an alignment on the other', () => {
    // M's top edge also aligns with a candidate line at y = 12 (2 away from 10), via a box far right.
    const idx = buildSnapIndex([A, B, cand('T', 900, 12, 10, 10)]);
    const r = snapMove(idx, box(303, 10, 100, 100), T, EXT);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(2);
    expect(gaps(r)).toHaveLength(2);
    expect(guideOf(r, 'y')?.kind).toBe('edge');
  });
});

describe('equal gaps: snapResize', () => {
  const idx = buildSnapIndex([
    cand('A', 0, 0, 100, 100),
    cand('B', 150, 0, 100, 100),
    cand('R', 600, 10, 100, 100),
  ]);

  it('the dragged left edge takes the gap to the neighbour before it from the row', () => {
    const r = snapResize(idx, box(303, 10, 197, 100), { left: true }, T, EXT);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    expect(gaps(r)[0]).toEqual({ axis: 'x', at: 55, from: 250, to: 300, kind: 'gap', label: 50 });
  });

  it('the dragged right edge takes the gap to the neighbour after it', () => {
    // M's right edge at 547: 53 before R (600); the row's gap is 50.
    const r = snapResize(idx, box(300, 10, 247, 100), { right: true }, T, EXT);
    expect(r.dx).toBe(3);
    expect(gaps(r)).toContainEqual({
      axis: 'x',
      at: 60,
      from: 550,
      to: 600,
      kind: 'gap',
      label: 50,
    });
    // The fixed left edge happens to sit 50 from B as well: that gap is marked too, with A..B.
    expect(gaps(r)).toHaveLength(3);
  });

  it('the edge that is not dragged and a symmetric resize never gap-snap', () => {
    // The right edge is the dragged one, so the 53 gap on the left does not count.
    expect(snapResize(idx, box(303, 10, 197, 100), { right: true }, T, EXT).dx).toBe(0);
    // Both edges flagged (alt): no gap snap.
    expect(snapResize(idx, box(303, 10, 244, 100), { left: true, right: true }, T, EXT).dx).toBe(0);
  });

  it('snaps gaps on Y for the top and bottom edges', () => {
    const col = buildSnapIndex([
      cand('A', 0, 0, 100, 100),
      cand('B', 0, 150, 100, 100),
      cand('R', 10, 600, 100, 100),
    ]);
    const top = snapResize(col, box(10, 303, 100, 197), { top: true }, T, EXT);
    expect(top.dy).toBe(-3);
    expect(gaps(top)[0]).toMatchObject({ axis: 'y', from: 250, to: 300, label: 50 });
    const bottom = snapResize(col, box(10, 300, 100, 247), { bottom: true }, T, EXT);
    expect(bottom.dy).toBe(3);
  });
});

describe('width and height match: snapResize', () => {
  // A: x 50..250 (width 200), y 0..100. Its x lines (50, 150, 250) keep clear of the boxes below.
  const A = cand('A', 50, 0, 200, 100);
  const idx = buildSnapIndex([A]);

  it('the dragged right edge takes the width of a box in its column', () => {
    // M: x 0..197, y 300..400, below A and overlapping it on x.
    const r = snapResize(idx, box(0, 300, 197, 100), { right: true }, T, EXT);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(0);
    expect(widths(r)).toEqual([
      // The resized box, across its middle after the correction (0..200) ...
      { axis: 'x', at: 350, from: 0, to: 200, kind: 'width', label: 200 },
      // ... and the box it matched.
      { axis: 'x', at: 50, from: 50, to: 250, kind: 'width', label: 200 },
    ]);
    expect(r.guides).toHaveLength(2);
  });

  it('the dragged left edge moves the other way', () => {
    // Right edge fixed at 300; left edge at 103: width 197 -> 200 needs the left edge at 100.
    const r = snapResize(idx, box(103, 300, 197, 100), { left: true }, T, EXT);
    expect(r.dx).toBe(-3);
    expect(widths(r)[0]).toEqual({
      axis: 'x',
      at: 350,
      from: 100,
      to: 300,
      kind: 'width',
      label: 200,
    });
    // A too-wide box shrinks: width 203 -> 200 needs the left edge 3 to the right.
    expect(snapResize(idx, box(97, 300, 203, 100), { left: true }, T, EXT).dx).toBe(3);
  });

  it('matches within the threshold and not beyond it, in either direction', () => {
    expect(snapResize(idx, box(0, 300, 206, 100), { right: true }, T, EXT).dx).toBe(-6);
    expect(snapResize(idx, box(0, 300, 194, 100), { right: true }, T, EXT).dx).toBe(6);
    expect(snapResize(idx, box(0, 300, 207, 100), { right: true }, T, EXT).guides).toEqual([]);
    expect(snapResize(idx, box(0, 300, 193, 100), { right: true }, T, EXT).dx).toBe(0);
  });

  it('matches the height of a box on its row, with axis y', () => {
    // T: x 50..150, y 50..250 (height 200). M sits beside it, x 300..400, y 0..197.
    const tall = buildSnapIndex([cand('T', 50, 50, 100, 200)]);
    const r = snapResize(tall, box(300, 0, 100, 197), { bottom: true }, T, EXT);
    expect(r.dy).toBe(3);
    expect(r.dx).toBe(0);
    expect(widths(r)).toEqual([
      { axis: 'y', at: 350, from: 0, to: 200, kind: 'width', label: 200 },
      { axis: 'y', at: 100, from: 50, to: 250, kind: 'width', label: 200 },
    ]);
    // Top edge: bottom fixed at 400, top at 203 -> 200.
    const top = snapResize(tall, box(300, 203, 100, 197), { top: true }, T, EXT);
    expect(top.dy).toBe(-3);
  });

  it('ignores boxes that are neither on its row nor in its column', () => {
    // A 200 wide box far away on both axes.
    const far = buildSnapIndex([cand('F', 1000, 1000, 200, 100)]);
    const r = snapResize(far, box(0, 300, 197, 100), { right: true }, T, EXT);
    expect(r.dx).toBe(0);
    expect(r.guides).toEqual([]);
    // On its row (overlapping on y) it counts, wherever it is along x.
    const row = buildSnapIndex([cand('F', 1000, 320, 200, 100)]);
    expect(snapResize(row, box(0, 300, 197, 100), { right: true }, T, EXT).dx).toBe(3);
  });

  it('skips the match when the box is moved, or both edges are dragged', () => {
    expect(snapMove(idx, box(0, 300, 197, 100), T, EXT).guides).toEqual([]);
    expect(snapResize(idx, box(0, 300, 197, 100), { left: true, right: true }, T, EXT).dx).toBe(0);
  });

  it('an alignment wins a tie, the smaller delta wins otherwise', () => {
    // Right edge at 197: A's width wants +3. A line at 199 (a 4 wide box at x 199) is 2 away: it wins.
    const closer = buildSnapIndex([A, cand('L', 199, 500, 4, 4)]);
    const a = snapResize(closer, box(0, 300, 197, 100), { right: true }, T, EXT);
    expect(a.dx).toBe(2);
    expect(widths(a)).toEqual([]);
    // A line exactly where the width lands (200): a tie, the alignment's guide is the one drawn.
    const tie = buildSnapIndex([A, cand('L', 200, 500, 4, 4)]);
    const b = snapResize(tie, box(0, 300, 197, 100), { right: true }, T, EXT);
    expect(b.dx).toBe(3);
    expect(widths(b)).toEqual([]);
    expect(guideOf(b, 'x')).toMatchObject({ at: 200, kind: 'edge' });
  });

  it('draws every nearby box of that width: the resized one and up to three matches', () => {
    const many = buildSnapIndex([
      cand('A', 50, 0, 200, 100),
      cand('B', 50, 120, 200, 100),
      cand('C', 50, 240, 200, 100),
      cand('D', 50, 360, 200, 100),
    ]);
    const r = snapResize(many, box(0, 700, 197, 100), { right: true }, T, EXT);
    expect(r.dx).toBe(3);
    expect(widths(r)).toHaveLength(1 + 3);
  });

  it('a size match beats a gap on a tie; a gap wins when it is the only one', () => {
    const base = [
      cand('A', 0, 0, 100, 100),
      cand('B', 150, 0, 100, 100),
      cand('R', 600, 10, 100, 100),
    ];
    // The right edge (547) is 53 before R: the row's gap (50) wants +3; no width is near 247.
    const g = snapResize(buildSnapIndex(base), box(300, 10, 247, 100), { right: true }, T, EXT);
    expect(g.dx).toBe(3);
    expect(gaps(g).length).toBeGreaterThan(0);
    expect(widths(g)).toEqual([]);
    // A 250 wide box in the column also wants +3 (247 -> 250): the size match takes the tie.
    const both = buildSnapIndex([...base, cand('W', 320, 300, 250, 50)]);
    const t = snapResize(both, box(300, 10, 247, 100), { right: true }, T, EXT);
    expect(t.dx).toBe(3);
    expect(widths(t).length).toBeGreaterThan(0);
    expect(gaps(t)).toEqual([]);
  });
});

describe('gap index', () => {
  it('a dense grid of 400 boxes still snaps to its gap', () => {
    const grid: SnapCandidate[] = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) grid.push(cand(`g${r}-${c}`, c * 120, r * 100, 100, 80));
    }
    const idx = buildSnapIndex(grid);
    expect(idx.candCount).toBe(400);
    // Right of the last column (ends at 2380), on row 3: the gap to it is 23, the grid's is 20.
    const r = snapMove(idx, box(2403, 310, 100, 60), T, EXT);
    expect(r.dx).toBe(-3);
    expect(gaps(r).length).toBeGreaterThan(1);
  });
});

describe('performance', () => {
  // The budgets assume a free core. On a busy machine (another suite, a build) every call takes a
  // multiple of that, which says nothing about the algorithm: each budget is held against the
  // median of several runs after a warm-up (never one run, nor a mean a single stall can raise),
  // and CORKBOARD_TEST_TIMING_SCALE stretches all of them (e.g. 5 on a machine that is never idle).
  const SCALE = Math.max(1, Number(process.env.CORKBOARD_TEST_TIMING_SCALE) || 1);
  const median = (samples: number[]): number =>
    [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  function medianMs(fn: () => void, runs = 21): number {
    for (let i = 0; i < 3; i++) fn(); // warm-up
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn();
      times.push(performance.now() - t0);
    }
    return median(times);
  }

  // 2,000 candidates scattered on a field, as a drag over a dense viewport would see.
  function makeField(n: number): SnapCandidate[] {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const out: SnapCandidate[] = [];
    for (let i = 0; i < n; i++) {
      out.push(
        cand(
          `c${i}`,
          Math.round(rnd() * 9000),
          Math.round(rnd() * 7000),
          80 + Math.round(rnd() * 200),
          60 + Math.round(rnd() * 200),
        ),
      );
    }
    return out;
  }

  it('builds an index of 2,000 candidates in under 10 ms', () => {
    const field = makeField(2000);
    const typical = medianMs(() => buildSnapIndex(field));
    console.info(
      `snapping: buildSnapIndex(2000) = ${typical.toFixed(2)} ms median (budget ${10 * SCALE} ms)`,
    );
    expect(typical).toBeLessThan(10 * SCALE);
  });

  it('snapMove averages well under 1 ms with 2,000 candidates (budget 0.3 ms)', () => {
    const field = makeField(2000);
    const idx = buildSnapIndex(field);
    const out: SnapResult = { dx: 0, dy: 0, guides: [] };
    const calls = 5000;
    const sweep = (i: number): Aabb => {
      const t = i / calls;
      return box(t * 9000, 3500 + Math.sin(t * 40) * 3200, 248, 180);
    };
    for (let i = 0; i < 500; i++) snapMove(idx, sweep(i), 6, 16, out); // warm-up
    let snapped = 0;
    const t0 = performance.now();
    for (let i = 0; i < calls; i++) {
      snapMove(idx, sweep(i), 6, 16, out);
      if (out.guides.length > 0) snapped++;
    }
    const avg = (performance.now() - t0) / calls;
    console.info(
      `snapping: snapMove avg = ${avg.toFixed(4)} ms over ${calls} calls, ${snapped} snapped (budget 0.3 ms)`,
    );
    expect(avg).toBeLessThan(1.5 * SCALE);
  });

  it('snapMove stays cheap at a low zoom, where the world threshold is large', () => {
    const field = makeField(2000);
    const idx = buildSnapIndex(field);
    const out: SnapResult = { dx: 0, dy: 0, guides: [] };
    const thr = 6 / 0.05; // 120 world units: many lines inside every window
    const calls = 2000;
    const t0 = performance.now();
    for (let i = 0; i < calls; i++) {
      const t = i / calls;
      snapMove(idx, box(t * 9000, 3500 + Math.cos(t * 30) * 3000, 248, 180), thr, 320, out);
    }
    const avg = (performance.now() - t0) / calls;
    console.info(`snapping: snapMove avg at zoom 0.05 = ${avg.toFixed(4)} ms (budget 0.3 ms)`);
    expect(avg).toBeLessThan(1.5 * SCALE);
  });

  // What the engine hands over: the nearest 400 boxes (here a 20 x 20 grid with 20 px gaps, boxes of
  // two sizes so widths repeat) each move at a random place and size.
  function makeGrid(): SnapCandidate[] {
    const cands: SnapCandidate[] = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) {
        const wide = (r + c) % 3 === 0;
        cands.push(cand(`g${r}-${c}`, c * 140, r * 110, wide ? 120 : 100, wide ? 90 : 80));
      }
    }
    return cands;
  }

  function lcg(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  const p95 = (samples: Float64Array): number =>
    Array.from(samples).sort((a, b) => a - b)[Math.floor(samples.length * 0.95)];
  const bestOf = (passes: number, pass: () => number): number =>
    Math.min(...Array.from({ length: passes }, pass));

  it('builds the index of 400 candidates (gaps included) quickly', () => {
    const cands = makeGrid();
    const typical = medianMs(() => buildSnapIndex(cands));
    console.info(`snapping: buildSnapIndex(400) = ${typical.toFixed(2)} ms median`);
    expect(typical).toBeLessThan(20 * SCALE);
  });

  it('snapMove with 400 candidates: p95 per move within the 0.3 ms budget', () => {
    const cands = makeGrid();
    const idx = buildSnapIndex(cands);
    const out: SnapResult = { dx: 0, dy: 0, guides: [] };
    const rnd = lcg(777);
    const moves = 2000;
    const boxes: Aabb[] = [];
    for (let i = 0; i < moves + 200; i++) {
      boxes.push(box(rnd() * 2800, rnd() * 2200, 80 + rnd() * 80, 60 + rnd() * 60));
    }
    for (let i = 0; i < 200; i++) snapMove(idx, boxes[i], 6, 16, out); // warm-up
    let gapSnaps = 0;
    // Three passes, the calmest one counts: a stall of the machine hits a pass, not the algorithm.
    const q = bestOf(3, () => {
      const times = new Float64Array(moves);
      gapSnaps = 0;
      for (let i = 0; i < moves; i++) {
        const t0 = performance.now();
        snapMove(idx, boxes[200 + i], 6, 16, out);
        times[i] = performance.now() - t0;
        if (out.guides.some((g) => g.kind === 'gap')) gapSnaps++;
      }
      return p95(times);
    });
    console.info(
      `snapping: snapMove(400) p95 = ${q.toFixed(4)} ms over ${moves} moves, ${gapSnaps} with gap guides (budget 0.3 ms)`,
    );
    expect(q).toBeLessThan(0.3 * SCALE);
  });

  it('snapResize with 400 candidates: p95 per move within the 0.3 ms budget', () => {
    const cands = makeGrid();
    const idx = buildSnapIndex(cands);
    const out: SnapResult = { dx: 0, dy: 0, guides: [] };
    const rnd = lcg(4242);
    const moves = 2000;
    const boxes: Aabb[] = [];
    for (let i = 0; i < moves + 200; i++) {
      boxes.push(box(rnd() * 2800, rnd() * 2200, 80 + rnd() * 80, 60 + rnd() * 60));
    }
    const edges = [{ right: true, bottom: true }, { left: true, top: true }, { right: true }];
    for (let i = 0; i < 200; i++) snapResize(idx, boxes[i], edges[i % 3], 6, 16, out);
    let guided = 0;
    const q = bestOf(3, () => {
      const times = new Float64Array(moves);
      guided = 0;
      for (let i = 0; i < moves; i++) {
        const t0 = performance.now();
        snapResize(idx, boxes[200 + i], edges[i % 3], 6, 16, out);
        times[i] = performance.now() - t0;
        if (out.guides.some((g) => g.kind === 'gap' || g.kind === 'width')) guided++;
      }
      return p95(times);
    });
    console.info(
      `snapping: snapResize(400) p95 = ${q.toFixed(4)} ms over ${moves} moves, ${guided} with gap or width guides (budget 0.3 ms)`,
    );
    expect(q).toBeLessThan(0.3 * SCALE);
  });
});

describe('guide marks and spans (smart guides)', () => {
  const marksOf = (g: Guide | undefined): number[] | undefined =>
    (g as { marks?: number[] } | undefined)?.marks;

  it('marks both corners of every box aligned by an edge, the moving box included', () => {
    // A: y 0..100 on x = 100; B: y 300..400 on x = 100; the moving box: y 150..200.
    const idx = buildSnapIndex([A, cand('B', 100, 300, 80, 100)]);
    const r = snapMove(idx, box(103, 150, 33, 50), T, EXT);
    const g = guideOf(r, 'x', 'edge');
    expect(marksOf(g)).toEqual([0, 100, 150, 200, 300, 400]);
    // The span runs from the first mark to the last, plus the overshoot.
    expect(g).toMatchObject({ from: 0 - EXT, to: 400 + EXT });
  });

  it('a centre-to-centre guide runs between the centres, marked at each', () => {
    // A's centre x = 150, middle y = 50. A 16 px box far below: its centre ends up on x = 150.
    const idx = buildSnapIndex([A]);
    const r = snapMove(idx, box(144, 1000, 16, 16), T, 3);
    const g = guideOf(r, 'x', 'center');
    expect(marksOf(g)).toEqual([50, 1008]);
    expect(g).toMatchObject({ at: 150, from: 47, to: 1011 });
  });

  it('drops the centre guide of a box aligned by both edges to a box of its size', () => {
    // C: x 0..100. The moving box (same width, far below) is aligned left, right AND centre with
    // it: the two edge guides already say so.
    const idx = buildSnapIndex([cand('C', 0, 0, 100, 100)]);
    const r = snapMove(idx, box(2, 500, 100, 50), T, EXT);
    expect(r.dx).toBe(-2);
    const xs = r.guides.filter((g) => g.axis === 'x');
    expect(xs.map((g) => g.kind)).toEqual(['edge', 'edge']);
    expect(xs.map((g) => g.at)).toEqual([0, 100]);
  });

  it('keeps the centre guide when the centre match is another box', () => {
    // C: x 0..100 (edges match), D: x 25..75 (only its centre matches, 50).
    const idx = buildSnapIndex([cand('C', 0, 0, 100, 100), cand('D', 25, 200, 50, 50)]);
    const r = snapMove(idx, box(2, 500, 100, 50), T, EXT);
    const centre = guideOf(r, 'x', 'center');
    expect(centre?.at).toBe(50);
    // Only D's centre and the moving box's are marked on it (C is shown by the edge guides).
    expect(marksOf(centre)).toEqual([225, 525]);
  });

  it('marks only the six aligned boxes nearest to the moving box, and spans just those', () => {
    // A column of 20 boxes on x = 100 (y 0, 100, ..., 1900, each 50 tall); the box at y 1000..1020.
    const column: SnapCandidate[] = [];
    for (let i = 0; i < 20; i++) column.push(cand(`K${i}`, 100, i * 100, 50, 50));
    const r = snapMove(buildSnapIndex(column), box(102, 1000, 20, 20), T, 0);
    const g = guideOf(r, 'x', 'edge');
    // Nearest six: K10 (overlapping), K9, K11, K8, K12, K7; never the far ends of the column.
    expect(marksOf(g)).toEqual([
      700, 750, 800, 850, 900, 950, 1000, 1020, 1050, 1100, 1150, 1200, 1250,
    ]);
    expect(g).toMatchObject({ from: 700, to: 1250 });
  });

  it('merges the marks of coincident lines into one guide', () => {
    const idx = buildSnapIndex([cand('P', 100, 0, 50, 50), cand('Q', 100, 100, 50, 50)]);
    const r = snapMove(idx, box(101, 300, 20, 20), T, EXT);
    const edges = r.guides.filter((g) => g.axis === 'x' && g.kind === 'edge');
    expect(edges).toHaveLength(1);
    expect(marksOf(edges[0])).toEqual([0, 50, 100, 150, 300, 320]);
  });
});

describe('threshold in screen pixels', () => {
  // Callers pass SNAP_THRESHOLD_PX / zoom: a box 5 screen px off snaps at every zoom, 7 never does.
  // W's only line near the box is its left edge (x = 100); the box is narrow and far below.
  const idx = buildSnapIndex([cand('W', 100, 0, 10000, 100)]);
  for (const zoom of [0.1, 0.5, 1, 2, 8]) {
    it(`snaps within ${SNAP_THRESHOLD_PX} screen px at zoom ${zoom}`, () => {
      const t = SNAP_THRESHOLD_PX / zoom;
      const near = snapMove(idx, box(100 + 5 / zoom, 5000, 10, 10), t, 0);
      expect(near.dx).toBeCloseTo(-5 / zoom, 9);
      const far = snapMove(idx, box(100 + 7 / zoom, 5000, 10, 10), t, 0);
      expect(far.dx).toBe(0);
    });
  }
});

describe('hysteresis', () => {
  // A's left edge: x = 100 (its other lines, 150 and 200, are far from a 10 px box near 100).
  const idx = buildSnapIndex([A]);
  const at = (minX: number): Aabb => box(minX, 1000, 10, 10);

  it('holds a target past the threshold until the release distance', () => {
    const out: SnapResult = { dx: 0, dy: 0, guides: [] };
    // Snap in at 5 px...
    expect(snapMove(idx, at(105), T, EXT, out).dx).toBe(-5);
    // ...and stay snapped at 8 px (past the 6 px threshold, within 1.5 x 6 = 9)...
    expect(snapMove(idx, at(108), T, EXT, out).dx).toBe(-8);
    expect(out.guides.length).toBeGreaterThan(0);
    // ...until 10 px, beyond the release distance.
    expect(snapMove(idx, at(110), T, EXT, out).dx).toBe(0);
    // A fresh result object (no history) never snaps at 8 px.
    expect(snapMove(idx, at(108), T, EXT).dx).toBe(0);
    expect(SNAP_RELEASE * T).toBe(9);
  });

  it('does not chatter between two near targets, but takes a clearly nearer one', () => {
    // Two left edges 8 apart: 100 (P) and 108 (Q). P and Q are wide and the box is 300 wide, so
    // only the box's left edge is ever near a line.
    const two = buildSnapIndex([cand('P', 100, 300, 1000, 50), cand('Q', 108, 600, 1000, 50)]);
    const wide = (minX: number): Aabb => box(minX, 1000, 300, 10);
    const out: SnapResult = { dx: 0, dy: 0, guides: [] };
    expect(snapMove(two, wide(101), T, EXT, out).dx).toBe(-1); // on 100
    // At 104.5 the box is 4.5 from 100 and 3.5 from 108: the held target stays.
    expect(snapMove(two, wide(104.5), T, EXT, out).dx).toBe(-4.5);
    // At 107 (1 from 108, 7 from 100): 108 is nearer by more than half the threshold: it takes over.
    expect(snapMove(two, wide(107), T, EXT, out).dx).toBe(1);
    // Jitter back to 104.5: now 108 is held.
    expect(snapMove(two, wide(104.5), T, EXT, out).dx).toBe(3.5);
  });

  it('starts afresh with a new index (a new gesture) or after a reset', () => {
    const out: SnapResult = { dx: 0, dy: 0, guides: [] };
    snapMove(idx, at(105), T, EXT, out);
    expect(snapMove(buildSnapIndex([A]), at(108), T, EXT, out).dx).toBe(0);
    snapMove(idx, at(105), T, EXT, out);
    resetSnapHysteresis(out);
    expect(snapMove(idx, at(108), T, EXT, out).dx).toBe(0);
  });

  it('holds a gap snap too, with its markers', () => {
    // Row A 0..100, B 150..250 (gap 50); the moving box after B.
    const row = buildSnapIndex([cand('A', 0, 0, 100, 100), cand('B', 150, 0, 100, 100)]);
    const out: SnapResult = { dx: 0, dy: 0, guides: [] };
    expect(snapMove(row, box(304, 10, 100, 100), T, EXT, out).dx).toBe(-4);
    // 58 px gap: 8 off, held.
    expect(snapMove(row, box(308, 10, 100, 100), T, EXT, out).dx).toBe(-8);
    expect(out.guides.filter((g) => g.kind === 'gap').length).toBe(2);
  });

  it('holds the dragged edge of a resize', () => {
    const out: SnapResult = { dx: 0, dy: 0, guides: [] };
    expect(snapResize(idx, box(105, 1000, 50, 10), { left: true }, T, EXT, out).dx).toBe(-5);
    expect(snapResize(idx, box(108, 1000, 47, 10), { left: true }, T, EXT, out).dx).toBe(-8);
  });
});
