// Small argument checks shared by the public entry points (`add`, `update`, the layout, camera and option
// setters...). Every failure is a `CorkboardError('invalid')` that names the call and the value, instead of a raw
// TypeError from deep inside or a NaN that lands in the store.
import { CorkboardError } from './errors';
import type { CardId } from './types';

export const bad = (where: string, what: string): never => {
  throw new CorkboardError('invalid', `${where}: ${what}`);
};

export const show = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'object' && v !== null) return Array.isArray(v) ? 'an array' : 'an object';
  return String(v);
};

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const finite = (where: string, field: string, v: unknown): void => {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(where, `${field} must be a finite number (got ${show(v)})`);
};

export const positive = (where: string, field: string, v: unknown): void => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    bad(where, `${field} must be a finite number > 0 (got ${show(v)})`);
  }
};

export const nonNegative = (where: string, field: string, v: unknown): void => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    bad(where, `${field} must be a finite number >= 0 (got ${show(v)})`);
  }
};

export const boolean = (where: string, field: string, v: unknown): void => {
  if (typeof v !== 'boolean') bad(where, `${field} must be a boolean (got ${show(v)})`);
};

/** A whole number >= `min`. */
export const integer = (where: string, field: string, v: unknown, min: number): void => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    bad(where, `${field} must be an integer >= ${min} (got ${show(v)})`);
  }
};

/** A limit: a number >= 0 where `Infinity` means "no cap" (NaN and negatives are refused). */
export const limit = (where: string, field: string, v: unknown): void => {
  if (typeof v !== 'number' || Number.isNaN(v) || v < 0) {
    bad(where, `${field} must be a number >= 0, or Infinity for no cap (got ${show(v)})`);
  }
};

export function oneOf<T extends string>(where: string, field: string, v: unknown, allowed: readonly T[]): void {
  if (!allowed.includes(v as T)) bad(where, `${field} must be one of ${allowed.map((a) => `'${a}'`).join(', ')} (got ${show(v)})`);
}

/** `o` as a record: an object, not null and not an array (`undefined` is for the caller to treat as "no options"). */
export function record(where: string, what: string, o: unknown): Record<string, unknown> {
  if (!isObject(o) || Array.isArray(o)) return bad(where, `${what} must be an object (got ${show(o)})`);
  return o;
}

/** The geometry every card must keep, whoever writes it: x, y, rot finite and w, h finite and > 0. Parts left out are not checked. */
export function assertGeometry(
  where: string,
  g: { x?: number; y?: number; w?: number; h?: number; rot?: number },
): void {
  if (g.x !== undefined) finite(where, 'x', g.x);
  if (g.y !== undefined) finite(where, 'y', g.y);
  if (g.w !== undefined) positive(where, 'w', g.w);
  if (g.h !== undefined) positive(where, 'h', g.h);
  if (g.rot !== undefined) finite(where, 'rot', g.rot);
}

/**
 * The ids a method takes, as a list: one id or an array of ids. `optional`: `undefined` means "all" and comes
 * back as `undefined`. Anything else (a number, `null`, an array with a non-string in it) is 'invalid'.
 */
export function idList(where: string, ids: unknown, optional: true): CardId[] | undefined;
export function idList(where: string, ids: unknown, optional?: false): CardId[];
export function idList(where: string, ids: unknown, optional = false): CardId[] | undefined {
  if (ids === undefined && optional) return undefined;
  if (typeof ids === 'string') return [ids];
  if (!Array.isArray(ids)) return bad(where, `ids must be a card id or an array of card ids (got ${show(ids)})`);
  for (let i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== 'string') bad(where, `ids[${i}] must be a card id (a string, got ${show(ids[i])})`);
  }
  return ids as CardId[];
}

/** A world rectangle `{ x0, y0, x1, y1 }` with finite corners. */
export function assertRect(where: string, r: unknown): void {
  if (!isObject(r)) return bad(where, `needs a rectangle { x0, y0, x1, y1 } (got ${show(r)})`);
  for (const k of ['x0', 'y0', 'x1', 'y1']) finite(where, k, r[k]);
}
