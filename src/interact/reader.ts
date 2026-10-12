import type { Element } from '../types';
import type { Box } from './geometry';

// What hit testing, the marquee, handles and resize sessions need from the store. `Store` satisfies it
// structurally, so tests can plug in any index.
export interface ElementReader {
  get(id: string): Element | undefined;
  // Elements whose world AABB intersects `box`. `out` is the caller's, cleared by the callee.
  searchInto(box: Box, out: Element[]): Element[];
  // Draw order, 0 = bottom.
  rank(id: string): number;
}
