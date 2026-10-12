import { describe, expect, it, vi } from 'vitest';
import { Store, type ChangeSet } from '../../src/store/Store';
import { el } from '../interact/fixtures';

const collect = (s: Store): ChangeSet[] => {
  const seen: ChangeSet[] = [];
  s.subscribe((e) => seen.push(e.change));
  return seen;
};

describe('Store: add / get / remove', () => {
  it('adds elements, emits one change and reads them back', () => {
    const s = new Store();
    const seen = collect(s);
    s.add([el('a'), el('b')]);
    expect(s.size).toBe(2);
    expect(s.has('a')).toBe(true);
    expect(s.get('b')?.id).toBe('b');
    expect(s.ids()).toEqual(['a', 'b']);
    expect(seen).toHaveLength(1);
    expect(seen[0].added.map((e) => e.id)).toEqual(['a', 'b']);
    expect(seen[0].source).toBe('local');
  });

  it('throws on a duplicate id', () => {
    const s = new Store();
    s.add([el('a')]);
    expect(() => s.add([el('a')])).toThrow(/duplicate/);
    expect(s.size).toBe(1);
  });

  it('removes what exists, ignores unknown ids and returns the removed elements', () => {
    const s = new Store();
    s.add([el('a'), el('b'), el('c')]);
    const seen = collect(s);
    const gone = s.remove(['b', 'nope']);
    expect(gone.map((e) => e.id)).toEqual(['b']);
    expect(s.has('b')).toBe(false);
    expect(s.ids()).toEqual(['a', 'c']);
    expect(seen).toHaveLength(1);
    expect(seen[0].removed.map((e) => e.id)).toEqual(['b']);
  });

  it('does not emit anything for a no-op', () => {
    const s = new Store();
    const seen = collect(s);
    s.add([]);
    s.remove(['missing']);
    expect(seen).toHaveLength(0);
  });

  it('passes the "load" source through', () => {
    const s = new Store();
    const seen = collect(s);
    s.add([el('a')], 'load');
    s.update('a', { x: 5 }, 'load');
    s.remove(['a'], 'load');
    expect(seen.map((c) => c.source)).toEqual(['load', 'load', 'load']);
  });

  it('clear() empties the store and reports every element as removed', () => {
    const s = new Store();
    s.add([el('a'), el('b')]);
    const seen = collect(s);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.searchInto({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }, [])).toEqual([]);
    expect(seen[0].removed.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('Store: update', () => {
  it('returns only the properties that changed', () => {
    const s = new Store();
    s.add([el('a', { x: 10 })]);
    expect(s.update('a', { x: 10, y: 20, locked: true })).toEqual(['y', 'locked']);
    expect(s.get('a')).toMatchObject({ x: 10, y: 20, locked: true });
  });

  it('is silent for an unchanged patch, an undefined value or an unknown id', () => {
    const s = new Store();
    s.add([el('a')]);
    const seen = collect(s);
    expect(s.update('a', { x: 0 })).toEqual([]);
    expect(s.update('a', { x: undefined })).toEqual([]);
    expect(s.update('nope', { x: 1 })).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('never mutates the previous element object', () => {
    const s = new Store();
    const a = el('a');
    s.add([a]);
    s.update('a', { x: 50 });
    expect(a.x).toBe(0);
    expect(s.get('a')?.x).toBe(50);
  });

  it('reports the element after the change with the changed props', () => {
    const s = new Store();
    s.add([el('a')]);
    const seen = collect(s);
    s.update('a', { w: 200, h: 120 });
    expect(seen).toHaveLength(1);
    expect(seen[0].updated).toHaveLength(1);
    expect(seen[0].updated[0].el.w).toBe(200);
    expect(seen[0].updated[0].props.sort()).toEqual(['h', 'w']);
  });
});

describe('Store: batch', () => {
  it('coalesces everything made inside into one ChangeSet', () => {
    const s = new Store();
    s.add([el('a')]);
    const listener = vi.fn();
    s.subscribe(listener);
    s.batch(() => {
      s.add([el('b')]);
      s.update('a', { x: 5 });
      s.remove(['b']);
    });
    expect(listener).toHaveBeenCalledTimes(1);
    const c = listener.mock.calls[0][0].change as ChangeSet;
    expect(c.added.map((e) => e.id)).toEqual(['b']);
    expect(c.removed.map((e) => e.id)).toEqual(['b']);
    expect(c.updated.map((u) => u.el.id)).toEqual(['a']);
  });

  it('folds repeated updates of one element into one entry with the merged props', () => {
    const s = new Store();
    s.add([el('a')]);
    const seen = collect(s);
    s.batch(() => {
      s.update('a', { x: 1 });
      s.update('a', { y: 2 });
      s.update('a', { x: 3 });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].updated).toHaveLength(1);
    expect(seen[0].updated[0].props.sort()).toEqual(['x', 'y']);
    expect(seen[0].updated[0].el).toMatchObject({ x: 3, y: 2 });
  });

  it('flushes once for nested batches and survives a throwing body', () => {
    const s = new Store();
    const seen = collect(s);
    s.batch(() => {
      s.batch(() => s.add([el('a')]));
      s.add([el('b')]);
    });
    expect(seen).toHaveLength(1);
    expect(() =>
      s.batch(() => {
        s.add([el('c')]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // The partial work was flushed and the depth counter is back to zero.
    expect(seen).toHaveLength(2);
    s.add([el('d')]);
    expect(seen).toHaveLength(3);
  });

  it('stops notifying after unsubscribe', () => {
    const s = new Store();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.add([el('a')]);
    off();
    s.add([el('b')]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('Store: spatial index', () => {
  const world = (b: Partial<{ minX: number; minY: number; maxX: number; maxY: number }>) => ({
    minX: -1e5,
    minY: -1e5,
    maxX: 1e5,
    maxY: 1e5,
    ...b,
  });

  it('finds elements by box and clears the caller\'s array first', () => {
    const s = new Store();
    s.add([el('a', { x: 0, y: 0 }), el('b', { x: 1000, y: 1000 })]);
    const out = [el('stale')];
    const hit = s.searchInto({ minX: 10, minY: 10, maxX: 20, maxY: 20 }, out);
    expect(hit).toBe(out);
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('follows an element after it moves', () => {
    const s = new Store();
    s.add([el('a', { x: 0, y: 0 })]);
    s.update('a', { x: 500, y: 500 });
    expect(s.searchInto({ minX: 0, minY: 0, maxX: 50, maxY: 50 }, [])).toEqual([]);
    expect(s.searchInto({ minX: 520, minY: 520, maxX: 530, maxY: 530 }, []).map((e) => e.id)).toEqual(['a']);
  });

  it('indexes the rotated AABB, and refreshes it when only the rotation changes', () => {
    const s = new Store();
    // 200 x 20 centred on (100, 10): rotated 90 degrees it spans y from -90 to 110.
    s.add([el('a', { x: 0, y: 0, w: 200, h: 20 })]);
    const probe = { minX: 95, minY: 90, maxX: 105, maxY: 100 };
    expect(s.searchInto(probe, [])).toEqual([]);
    s.update('a', { rot: 90 });
    expect(s.searchInto(probe, []).map((e) => e.id)).toEqual(['a']);
  });

  it('returns the updated object for a non-geometry change', () => {
    const s = new Store();
    s.add([el('a')]);
    s.update('a', { locked: true });
    const [hit] = s.searchInto(world({}), []);
    expect(hit.locked).toBe(true);
    expect(hit).toBe(s.get('a'));
  });

  it('drops removed elements from the index', () => {
    const s = new Store();
    s.add([el('a'), el('b', { x: 300 })]);
    s.remove(['a']);
    expect(s.searchInto(world({}), []).map((e) => e.id)).toEqual(['b']);
  });
});

describe('Store: draw order', () => {
  it('ranks follow insertion order and appending keeps orderVersion', () => {
    const s = new Store();
    const v = s.orderVersion;
    s.add([el('a'), el('b'), el('c')]);
    expect(['a', 'b', 'c'].map((i) => s.rank(i))).toEqual([0, 1, 2]);
    expect(s.rank('nope')).toBe(-1);
    expect(s.orderVersion).toBe(v);
  });

  it('closes the gap and bumps orderVersion on remove', () => {
    const s = new Store();
    s.add([el('a'), el('b'), el('c')]);
    const v = s.orderVersion;
    s.remove(['a']);
    expect(s.orderVersion).toBe(v + 1);
    expect(s.rank('b')).toBe(0);
    expect(s.rank('c')).toBe(1);
    // A later append lands on top with a consistent rank.
    s.add([el('d')]);
    expect(s.rank('d')).toBe(2);
  });

  it('bringToFront lifts the ids keeping their relative order, and reports an "order" update', () => {
    const s = new Store();
    s.add([el('a'), el('b'), el('c'), el('d')]);
    const seen = collect(s);
    const v = s.orderVersion;
    s.bringToFront(['b', 'a', 'ghost']);
    expect(s.ids()).toEqual(['c', 'd', 'a', 'b']);
    expect(s.rank('a')).toBe(2);
    expect(s.rank('b')).toBe(3);
    expect(s.orderVersion).toBe(v + 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].updated.map((u) => u.props)).toEqual([['order'], ['order']]);
  });

  it('bringToFront with nothing known does nothing', () => {
    const s = new Store();
    s.add([el('a')]);
    const seen = collect(s);
    const v = s.orderVersion;
    s.bringToFront(['ghost']);
    expect(s.orderVersion).toBe(v);
    expect(seen).toHaveLength(0);
  });
});
