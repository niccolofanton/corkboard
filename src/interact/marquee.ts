// Marquee (rubber-band) selection and selection bounds. Pure: reads elements through `CardReader`.
//
// `touch` selects every element whose rotated rect meets the box; `contain` only those wholly inside it.
import type { Card } from '../types';
import type { Aabb, WorldRect } from './geometry';
import {
  boxIntersectsRotatedRect,
  boxUnion,
  elementBox,
  rotatedRectInsideBox,
  worldRectOf,
} from './geometry';
import type { CardReader } from './reader';

/** Options of {@link elementsInBox}. */
export interface MarqueeOptions {
  // Default true: locked elements are not selectable by a marquee (a click still selects them).
  skipLocked?: boolean;
  filter?: (el: Card) => boolean;
}

const hits: Card[] = [];
const scratch: Card[] = [];

/** Ids of the elements selected by dragging `box`, ordered by draw order (bottom first). */
export function elementsInBox(
  reader: CardReader,
  box: Aabb,
  mode: 'touch' | 'contain',
  opts: MarqueeOptions = {},
): string[] {
  const skipLocked = opts.skipLocked ?? true;
  const filter = opts.filter;
  const list = reader.searchInto(box, scratch);
  hits.length = 0;
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (skipLocked && el.locked) continue;
    if (filter !== undefined && !filter(el)) continue;
    const r = worldRectOf(el);
    const ok = mode === 'contain' ? rotatedRectInsideBox(r, box) : boxIntersectsRotatedRect(box, r);
    if (ok) hits.push(el);
  }
  list.length = 0;
  if (hits.length > 1) hits.sort((a, b) => reader.rank(a.id) - reader.rank(b.id));
  const ids: string[] = new Array<string>(hits.length);
  for (let i = 0; i < hits.length; i++) ids[i] = hits[i].id;
  hits.length = 0;
  return ids;
}

/**
 * Union AABB of the elements, plus the rotated world rect when exactly one element is selected (so the
 * selection outline follows its rotation). Locked elements count; missing ids are ignored; null when
 * nothing resolves.
 */
export function selectionBounds(
  reader: CardReader,
  ids: readonly string[],
): { box: Aabb; rect: WorldRect | null } | null {
  let box: Aabb | null = null;
  let count = 0;
  let single: WorldRect | null = null;
  for (let i = 0; i < ids.length; i++) {
    const el = reader.get(ids[i]);
    if (!el) continue;
    const b = elementBox(el);
    box = box === null ? b : boxUnion(box, b);
    count++;
    if (count === 1) single = worldRectOf(el);
  }
  if (box === null) return null;
  return { box, rect: count === 1 ? single : null };
}
