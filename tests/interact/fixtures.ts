import type { Element } from '../../src/types';
import { boxesIntersect, elementBox, type Box } from '../../src/interact/geometry';
import type { ElementReader } from '../../src/interact/reader';

// A card with sensible defaults; override what the test cares about.
export function el(id: string, over: Partial<Element> = {}): Element {
  return {
    id,
    kind: 'image',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rot: 0,
    locked: false,
    media: { src: `${id}.jpg` },
    radius: 8,
    aspectLocked: true,
    ...over,
  };
}

// A tiny reader over a list: draw order is the list order (first = bottom).
export function readerOf(list: readonly Element[]): ElementReader & { byId: Map<string, Element> } {
  const byId = new Map(list.map((e) => [e.id, e]));
  const order = list.map((e) => e.id);
  return {
    byId,
    get: (id) => byId.get(id),
    rank: (id) => order.indexOf(id),
    searchInto(box: Box, out: Element[]): Element[] {
      out.length = 0;
      for (const e of byId.values()) if (boxesIntersect(box, elementBox(e))) out.push(e);
      return out;
    },
  };
}
