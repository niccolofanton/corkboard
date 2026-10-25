import type { Card } from '../types';
import type { Aabb } from './geometry';

/** A read-only view of the cards, for the hit test. */
export interface CardReader {
  get(id: string): Card | undefined;
  // Elements whose world AABB intersects `box`. `out` is the caller's, cleared by the callee.
  searchInto(box: Aabb, out: Card[]): Card[];
  // Draw order, 0 = bottom.
  rank(id: string): number;
}
