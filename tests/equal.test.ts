import { describe, expect, it } from 'vitest';
import { deepEqual } from '../src/equal';

type Tree = { l: Tree | { leaf: number }; r: Tree | { leaf: number } };

// 2^depth paths, depth + 1 distinct objects.
const dag = (depth: number): unknown => {
  let o: unknown = { leaf: 1 };
  for (let i = 0; i < depth; i++) o = { l: o, r: o };
  return o;
};

describe('deepEqual', () => {
  it('compares plain objects and arrays by value; undefined equals missing', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual(0, -0)).toBe(true);
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(new Date(0), new Date(0))).toBe(false);
  });

  it('looks at own keys only', () => {
    expect(deepEqual({}, { constructor: 'Foo' })).toBe(false);
    expect(deepEqual({ constructor: 'Foo' }, {})).toBe(false);
    expect(deepEqual({}, { toString: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, hasOwnProperty: 'x' })).toBe(false);
    expect(deepEqual({ constructor: 'Foo' }, { constructor: 'Foo' })).toBe(true);
    expect(deepEqual({ constructor: undefined }, {})).toBe(true);
    expect(deepEqual({ toString: 1 }, JSON.parse('{"toString":1}'))).toBe(true);
    expect(deepEqual(JSON.parse('{"__proto__":{"x":1}}'), {})).toBe(false);
  });

  it('compares a value that shares parts in time linear in its distinct objects', () => {
    const a = dag(22);
    const b = structuredClone(a);
    const t0 = performance.now();
    expect(deepEqual(a, b)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(200);
    // And finds a difference deep inside a shared part.
    const c = structuredClone(a) as Tree;
    let n: Tree | { leaf: number } = c;
    while ('l' in n && 'l' in (n.l as Tree)) n = n.l as Tree;
    ((n as Tree).l as { leaf: number }).leaf = 2;
    const t1 = performance.now();
    expect(deepEqual(a, c)).toBe(false);
    expect(performance.now() - t1).toBeLessThan(200);
  });

  it('terminates on a value that points back to itself', () => {
    const mk = () => {
      const c: Record<string, unknown> = {};
      c.l = c;
      c.r = c;
      return c;
    };
    const t0 = performance.now();
    expect(deepEqual(mk(), mk())).toBe(true);
    const other = mk();
    other.extra = 1;
    expect(deepEqual(mk(), other)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('is false past a nesting depth of 64', () => {
    const deep = (n: number): unknown => (n === 0 ? { v: 1 } : { c: deep(n - 1) });
    expect(deepEqual(deep(10), deep(10))).toBe(true);
    expect(deepEqual(deep(100), deep(100))).toBe(false);
  });
});
