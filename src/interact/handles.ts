// Resize handles of the current selection: which handles exist, where they are in world space, which
// cursor each one shows, and which handle a pointer position is on. Pure; the overlay draws
// `SelectionHandles` and the interaction controller feeds pointer positions to `handleAt`.
import type { Element } from '../types';
import type { Box, WorldRect } from './geometry';
import { boxOfRect, boxUnion, corners, fromRectLocal, toRectLocal, worldRectOf } from './geometry';
import type { ElementReader } from './reader';

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface Handle {
  id: HandleId;
  // World position of the handle centre.
  x: number;
  y: number;
  cursor: string;
}

export interface SelectionHandles {
  // The rect the handles sit on: the element's rotated world rect (single selection), the shared
  // axis-aligned bounding rect (several).
  rect: WorldRect;
  // The four corners, drawn.
  handles: Handle[];
  // The edges that resize by dragging the edge itself (`handleAt` finds them): present only when every
  // selected element may change its aspect.
  edges: HandleId[];
}

// Screen-px constants.
export const HANDLE_HIT_PX = 10;
// Below this on-screen side length the edge on that side is not grabbable: its band would sit on top
// of the corner handles.
const EDGE_HANDLE_MIN_PX = 24;
// The grab band of an edge, screen px across (half either side of the edge line).
export const EDGE_HIT_PX = 8;

// Direction of each handle in the element's own frame: -1 = west / north, +1 = east / south.
export const HANDLE_DIRS: Readonly<Record<HandleId, readonly [number, number]>> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

// Handle id -> axis angle, degrees clockwise from east, modulo 180 (the cursor shows a line along it).
const BASE_AXIS: Readonly<Record<HandleId, number>> = {
  e: 0,
  w: 0,
  se: 45,
  nw: 45,
  s: 90,
  n: 90,
  sw: 135,
  ne: 135,
};
const AXIS_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const;

// The standard resize cursor, turned to the nearest 45 degrees of the element's rotation.
export function resizeCursor(id: HandleId, rotDeg: number): string {
  const step = Math.round((BASE_AXIS[id] + rotDeg) / 45);
  return AXIS_CURSORS[((step % 4) + 4) % 4];
}

// Axis-aligned box of the rotated rects themselves: what resize handles wrap.
export function geometryBox(rects: readonly WorldRect[]): Box | null {
  let box: Box | null = null;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    let b: Box;
    if (r.rot === 0) {
      b = boxOfRect(r);
    } else {
      const c = corners(r);
      b = {
        minX: Math.min(c[0], c[2], c[4], c[6]),
        minY: Math.min(c[1], c[3], c[5], c[7]),
        maxX: Math.max(c[0], c[2], c[4], c[6]),
        maxY: Math.max(c[1], c[3], c[5], c[7]),
      };
    }
    box = box === null ? b : boxUnion(box, b);
  }
  return box;
}

function make(rect: WorldRect, id: HandleId, rot: number): Handle {
  const d = HANDLE_DIRS[id];
  const p = fromRectLocal(rect, ((d[0] + 1) / 2) * rect.w, ((d[1] + 1) / 2) * rect.h);
  return { id, x: p.x, y: p.y, cursor: resizeCursor(id, rot) };
}

// The handles of the selection, or null for an empty set or when any element is locked.
export function selectionHandles(
  reader: ElementReader,
  ids: readonly string[],
  zoom: number,
): SelectionHandles | null {
  const els: Element[] = [];
  const rects: WorldRect[] = [];
  for (let i = 0; i < ids.length; i++) {
    const el = reader.get(ids[i]);
    if (!el) continue;
    if (el.locked) return null;
    els.push(el);
    rects.push(worldRectOf(el));
  }
  if (els.length === 0) return null;
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  const free = els.every((e) => !e.aspectLocked);

  if (els.length > 1) {
    const b = geometryBox(rects);
    if (b === null) return null;
    const rect: WorldRect = { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY, rot: 0 };
    return {
      rect,
      handles: (['nw', 'ne', 'se', 'sw'] as const).map((id) => make(rect, id, 0)),
      edges: [],
    };
  }

  const rect = rects[0];
  const edges: HandleId[] = [];
  if (free) {
    if (rect.w * z >= EDGE_HANDLE_MIN_PX) edges.push('n', 's');
    if (rect.h * z >= EDGE_HANDLE_MIN_PX) edges.push('e', 'w');
  }
  return {
    rect,
    handles: (['nw', 'ne', 'se', 'sw'] as const).map((id) => make(rect, id, rect.rot)),
    edges,
  };
}

// The handle under the pointer, if any. Hit boxes are `hitPx` screen px squares; where boxes overlap
// (tiny selections) the nearest centre wins. Corners are tested before edges.
export function handleAt(
  sel: SelectionHandles,
  wx: number,
  wy: number,
  zoom: number,
  hitPx: number = HANDLE_HIT_PX,
): Handle | null {
  const half = hitPx / 2 / (zoom > 0 ? zoom : 1);
  let best: Handle | null = null;
  let bestD = Infinity;
  for (let i = 0; i < sel.handles.length; i++) {
    const h = sel.handles[i];
    const dx = Math.abs(wx - h.x);
    const dy = Math.abs(wy - h.y);
    if (dx > half || dy > half) continue;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      best = h;
      bestD = d;
    }
  }
  return best ?? edgeAt(sel, wx, wy, zoom);
}

// The resizable edge under the pointer: a band of EDGE_HIT_PX across the edge line, over its length
// (the corner handles are tested first, so they win at the ends). The band never takes more than a
// quarter of a small side, so the middle of a tiny element can still be grabbed to move it.
function edgeAt(sel: SelectionHandles, wx: number, wy: number, zoom: number): Handle | null {
  if (sel.edges.length === 0) return null;
  const z = zoom > 0 ? zoom : 1;
  const r = sel.rect;
  const half = Math.min(EDGE_HIT_PX / 2 / z, r.w / 4, r.h / 4);
  const p = toRectLocal(r, wx, wy);
  const inX = p.x >= -half && p.x <= r.w + half;
  const inY = p.y >= -half && p.y <= r.h + half;
  let id: HandleId | null = null;
  let d = Infinity;
  for (const e of sel.edges) {
    const dir = HANDLE_DIRS[e];
    const horizontal = dir[1] !== 0; // n / s: a horizontal edge
    const across = horizontal
      ? Math.abs(p.y - (dir[1] > 0 ? r.h : 0))
      : Math.abs(p.x - (dir[0] > 0 ? r.w : 0));
    if (across > half || !(horizontal ? inX : inY)) continue;
    if (across < d) {
      d = across;
      id = e;
    }
  }
  if (id === null) return null;
  const dir = HANDLE_DIRS[id];
  const lx = dir[0] === 0 ? Math.min(Math.max(p.x, 0), r.w) : ((dir[0] + 1) / 2) * r.w;
  const ly = dir[1] === 0 ? Math.min(Math.max(p.y, 0), r.h) : ((dir[1] + 1) / 2) * r.h;
  const at = fromRectLocal(r, lx, ly);
  return { id, x: at.x, y: at.y, cursor: resizeCursor(id, r.rot) };
}
