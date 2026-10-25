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
    expect(seen[0].source).toBe('api');
  });

  it('throws on a duplicate id', () => {
    const s = new Store();
    s.add([el('a')]);
    expect(() => s.add([el('a')])).toThrow(/duplicate/);
    expect(s.size).toBe(1);
  });

  it('is atomic: a duplicate anywhere in the batch inserts nothing and fires nothing', () => {
    const s = new Store();
    s.add([el('a')]);
    const seen = collect(s);
    expect(() => s.add([el('b'), el('a')])).toThrow(/duplicate/);
    expect(() => s.add([el('c'), el('c')])).toThrow(/duplicate/);
    expect(s.ids()).toEqual(['a']);
    expect(s.has('b')).toBe(false);
    expect(s.searchInto({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }, [])).toHaveLength(1);
    expect(seen).toHaveLength(0);
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
    expect([...seen[0].updated[0].props].sort()).toEqual(['h', 'w']);
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
    // `b` came and went inside the batch: it is not in the change at all.
    expect(c.added).toEqual([]);
    expect(c.removed).toEqual([]);
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
    expect([...seen[0].updated[0].props].sort()).toEqual(['x', 'y']);
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

  it('bringToFront lifts the ids keeping their relative order, and reports the order change', () => {
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
    expect(seen[0].updated).toEqual([]);
    // Just the ids given, each with the card below it before and after.
    expect(seen[0].order).toEqual({
      moved: [
        { id: 'a', prevBelow: null, nextBelow: 'd' },
        { id: 'b', prevBelow: 'a', nextBelow: 'a' },
      ],
    });
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

describe('Store: change sources, prev and props', () => {
  it('defaults to "api" and carries the source given', () => {
    const s = new Store();
    const seen = collect(s);
    s.add([el('a'), el('b')]);
    s.update('a', { x: 1 });
    s.update('a', { x: 2 }, 'user');
    s.bringToFront(['a'], 'user');
    s.remove(['a'], 'system');
    s.update('b', { x: 9 }, 'remote');
    expect(seen.map((c) => c.source)).toEqual(['api', 'api', 'user', 'user', 'system', 'remote']);
  });

  it('clear takes a source; a clear and an add in one batch are one change set', () => {
    const s = new Store();
    s.add([el('a'), el('b')]);
    const seen = collect(s);
    s.batch(() => {
      s.clear('load');
      s.add([el('c')], 'load');
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe('load');
    expect(seen[0].removed.map((e) => e.id)).toEqual(['a', 'b']);
    expect(seen[0].added.map((e) => e.id)).toEqual(['c']);
    expect(s.ids()).toEqual(['c']);
  });

  it('update reports the element before the change as prev', () => {
    const s = new Store();
    s.add([el('a')]);
    const before = s.get('a')!;
    const seen = collect(s);
    s.update('a', { w: 321 });
    expect(seen[0].updated[0].prev).toBe(before);
    expect(seen[0].updated[0].el).toBe(s.get('a'));
    expect(seen[0].updated[0].prev.w).not.toBe(321);
  });

  it('a z-order change is in `order`, not in `updated`; an update of the same batch keeps its prev', () => {
    const s = new Store();
    s.add([el('a'), el('b')]);
    const seen = collect(s);
    s.bringToFront(['a']);
    expect(seen[0].updated).toEqual([]);
    expect(seen[0].order).toEqual({ moved: [{ id: 'a', prevBelow: null, nextBelow: 'b' }] });
    seen.length = 0;
    const first = s.get('b')!;
    s.batch(() => {
      s.update('b', { x: 77 });
      s.bringToFront(['b']);
    });
    expect(seen[0].updated).toHaveLength(1);
    expect(seen[0].updated[0].prev).toBe(first);
    expect(seen[0].updated[0].el.x).toBe(77);
    expect([...seen[0].updated[0].props]).toEqual(['x']);
    expect(seen[0].order).toEqual({ moved: [{ id: 'b', prevBelow: null, nextBelow: 'a' }] });
  });

  it('a batch folds a big run of updates in linear time', () => {
    const s = new Store();
    const n = 5000;
    s.add(Array.from({ length: n }, (_, i) => el(`c${i}`)));
    const seen = collect(s);
    const t = performance.now();
    s.batch(() => {
      for (let i = 0; i < n; i++) s.update(`c${i}`, { x: i + 1 });
      for (let i = 0; i < n; i++) s.update(`c${i}`, { y: i + 1 });
    });
    expect(seen[0].updated).toHaveLength(n);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('Store: net diff per id', () => {
  const ids = (l: readonly { id: string }[]) => l.map((e) => e.id);

  it('add then remove of a card cancels out', () => {
    const s = new Store();
    s.add([el('keep')]);
    const seen = collect(s);
    s.batch(() => {
      s.add([el('x')]);
      s.remove(['x']);
    });
    expect(seen).toHaveLength(0);
  });

  it('remove then add of the same id is one update, from the first prev to the last el', () => {
    const s = new Store();
    s.add([el('a', { x: 1 }), el('b')]);
    const old = s.get('a')!;
    const seen = collect(s);
    const fresh = el('a', { x: 9, w: 50, media: old.media });
    s.batch(() => {
      s.remove(['a']);
      s.add([fresh]);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].added).toEqual([]);
    expect(seen[0].removed).toEqual([]);
    expect(seen[0].updated).toHaveLength(1);
    expect(seen[0].updated[0].prev).toBe(old);
    expect(seen[0].updated[0].el).toBe(fresh);
    expect([...seen[0].updated[0].props].sort()).toEqual(['w', 'x']);
    // The card went to the top of the draw order: that is reported too.
    expect(seen[0].order).toEqual({ moved: [{ id: 'b', prevBelow: 'a', nextBelow: null }] });
  });

  it('add then update is one add carrying the final card', () => {
    const s = new Store();
    const seen = collect(s);
    s.batch(() => {
      s.add([el('a')]);
      s.update('a', { x: 5 });
      s.update('a', { y: 6 });
    });
    expect(ids(seen[0].added)).toEqual(['a']);
    expect(seen[0].added[0]).toMatchObject({ x: 5, y: 6 });
    expect(seen[0].updated).toEqual([]);
    expect(seen[0].order).toBeUndefined();
  });

  it('a card that ends up as it started (A to B to A) is dropped, and so is a batch with no net change', () => {
    const s = new Store();
    s.add([el('a')]);
    const seen = collect(s);
    s.batch(() => {
      s.update('a', { x: 5 });
      s.update('a', { x: 0 });
    });
    s.batch(() => {});
    expect(seen).toHaveLength(0);
  });

  it('props compare each top-level field with Object.is: a media replaced as a whole counts, equal contents or not', () => {
    const s = new Store();
    s.add([el('a')]);
    const seen = collect(s);
    s.update('a', { media: { src: 'a.jpg' } });
    expect(seen[0].updated[0].props).toEqual(['media']);
    // Putting back the very same object is no change at all.
    const media = s.get('a')!.media;
    s.batch(() => {
      s.update('a', { media: { src: 'other.jpg' } });
      s.update('a', { media });
    });
    expect(seen).toHaveLength(1);
  });

  it('never lists an id twice across added, removed and updated', () => {
    const s = new Store();
    s.add([el('a'), el('b'), el('c'), el('d')]);
    const seen = collect(s);
    s.batch(() => {
      s.remove(['a']);
      s.add([el('a', { x: 3 })]);
      s.update('b', { x: 1 });
      s.remove(['c']);
      s.add([el('e')]);
      s.update('e', { y: 2 });
      s.remove(['d']);
      s.add([el('d')]);
      s.remove(['d']);
    });
    const c = seen[0];
    const all = [...ids(c.added), ...ids(c.removed), ...c.updated.map((u) => u.el.id)];
    expect(new Set(all).size).toBe(all.length);
    expect(ids(c.added)).toEqual(['e']);
    expect(ids(c.removed).sort()).toEqual(['c', 'd']);
    expect(c.updated.map((u) => u.el.id).sort()).toEqual(['a', 'b']);
  });

  it('clear + add of the same ids in one batch is an update per changed card (a load)', () => {
    const s = new Store();
    s.add([el('a'), el('b')]);
    const a = s.get('a')!;
    const bMedia = s.get('b')!.media;
    const seen = collect(s);
    s.batch(() => {
      s.clear('load');
      s.add([a, el('b', { x: 9, media: bMedia }), el('c')], 'load');
    });
    expect(seen[0].source).toBe('load');
    expect(ids(seen[0].added)).toEqual(['c']);
    expect(seen[0].removed).toEqual([]);
    expect(seen[0].updated.map((u) => [u.el.id, u.props])).toEqual([['b', ['x']]]);
  });
});

describe('Store: order in the change set', () => {
  it('a pure append has no `order`; a removal has one, so an undo can restore the depth', () => {
    const s = new Store();
    const seen = collect(s);
    s.add([el('a'), el('b')]);
    s.add([el('c')]);
    expect(seen.map((c) => c.order)).toEqual([undefined, undefined]);
    s.remove(['b']);
    // The removed card with the card that was below it: undoing the delete puts it back there.
    expect(seen[2].order).toEqual({ moved: [{ id: 'b', prevBelow: 'a', nextBelow: null }] });
  });

  it('prev is the order before the batch even when cards were appended first', () => {
    const s = new Store();
    s.add([el('a'), el('b')]);
    const seen = collect(s);
    s.batch(() => {
      s.add([el('x')]);
      s.bringToFront(['a']);
    });
    // x was appended on top (no entry); a left the bottom and sits above x now.
    expect(seen[0].order).toEqual({ moved: [{ id: 'a', prevBelow: null, nextBelow: 'x' }] });
  });

  it('sendToBack, setOrder and a reorder that changes nothing', () => {
    const s = new Store();
    s.add([el('a'), el('b'), el('c')]);
    const seen = collect(s);
    const v = s.orderVersion;
    s.sendToBack(['c', 'ghost']);
    expect(s.ids()).toEqual(['c', 'a', 'b']);
    expect(seen[0].order).toEqual({ moved: [{ id: 'c', prevBelow: 'b', nextBelow: null }] });
    s.setOrder(['b', 'c', 'a'], 'user');
    expect(s.ids()).toEqual(['b', 'c', 'a']);
    expect(s.rank('a')).toBe(2);
    expect(seen[1].source).toBe('user');
    expect(s.orderVersion).toBe(v + 2);
    s.bringToFront(['a']);
    s.setOrder(['b', 'c', 'a']);
    s.sendToBack(['b']);
    expect(seen).toHaveLength(2);
  });

  it('setOrder needs every id exactly once, else throws invalid and changes nothing', () => {
    const s = new Store();
    s.add([el('a'), el('b')]);
    const seen = collect(s);
    for (const bad of [['a'], ['a', 'b', 'c'], ['a', 'a'], ['a', 'x'], []]) {
      expect(() => s.setOrder(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
    expect(s.ids()).toEqual(['a', 'b']);
    expect(seen).toHaveLength(0);
  });

  it('applyOrderMoves places each card directly above its nextBelow, bottom first; entries with a missing card or anchor are skipped', () => {
    const s = new Store();
    s.add([el('a'), el('b'), el('c'), el('d')]);
    s.applyOrderMoves([
      { id: 'd', prevBelow: 'c', nextBelow: null },
      { id: 'a', prevBelow: null, nextBelow: 'd' },
    ]);
    expect(s.ids()).toEqual(['d', 'a', 'b', 'c']);
    const seen = collect(s);
    s.applyOrderMoves([
      { id: 'ghost', prevBelow: null, nextBelow: 'a' },
      { id: 'b', prevBelow: 'a', nextBelow: 'ghost' },
      { id: 'c', prevBelow: 'b', nextBelow: 'c' },
    ]);
    expect(s.ids()).toEqual(['d', 'a', 'b', 'c']);
    expect(seen).toHaveLength(0);
  });

  it('a draw-order lift changes rank() only: not ids(), not the change events; remove and clear drop it', () => {
    const s = new Store();
    s.add([el('a'), el('b'), el('c')]);
    const seen = collect(s);
    const v = s.orderVersion;
    s.lift(['a', 'ghost']);
    expect(s.ids()).toEqual(['a', 'b', 'c']);
    expect(s.rank('a')).toBe(3);
    expect(s.rank('b')).toBe(1);
    expect(s.orderVersion).toBe(v + 1);
    s.remove(['b']);
    expect(s.rank('a')).toBe(2);
    s.lift([]);
    expect(s.rank('a')).toBe(0);
    expect(seen.map((c) => c.order)).toEqual([{ moved: [{ id: 'b', prevBelow: 'a', nextBelow: null }] }]);
  });
});

describe('Store: source rules', () => {
  it('batch(fn, source) tags what is inside; the outermost named source wins', () => {
    const s = new Store();
    s.add([el('a')]);
    const seen = collect(s);
    s.batch(() => s.update('a', { x: 1 }), 'remote');
    s.batch(() => {
      s.batch(() => s.update('a', { x: 2 }), 'inner');
      s.update('a', { x: 3 }, 'user');
    }, 'outer');
    s.batch(() => {
      s.batch(() => s.update('a', { x: 4 }), 'inner');
    });
    expect(seen.map((c) => c.source)).toEqual(['remote', 'outer', 'inner']);
  });

  it('"load" wins over the others in the same batch', () => {
    const s = new Store();
    s.add([el('a')]);
    const seen = collect(s);
    s.batch(() => {
      s.update('a', { x: 1 }, 'user');
      s.add([el('b')], 'load');
    }, 'remote');
    expect(seen[0].source).toBe('load');
  });

  it('replaceAll marks the change set as a reload and is still a net diff', () => {
    const s = new Store();
    s.add([el('a'), el('b')]);
    const a = s.get('a')!;
    const seen = collect(s);
    s.replaceAll([a, el('c')]);
    expect(seen[0]).toMatchObject({ source: 'load', reload: true });
    expect(seen[0].added.map((e) => e.id)).toEqual(['c']);
    expect(seen[0].removed.map((e) => e.id)).toEqual(['b']);
    expect(seen[0].updated).toEqual([]);
    s.update('a', { x: 5 });
    expect(seen[1].reload).toBeUndefined();
    expect(() => s.replaceAll([el('d'), el('d')])).toThrow(/duplicate/);
    expect(s.ids()).toEqual(['a', 'c']);
  });
});

describe('Store: listener isolation', () => {
  it('a listener that throws is reported and does not stop the others', () => {
    const s = new Store();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('boom');
    const after = vi.fn();
    s.subscribe(() => {
      throw boom;
    });
    s.subscribe(after);
    s.add([el('a')]);
    expect(after).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('change listener'), boom);
    // And the store is still usable.
    s.add([el('b')]);
    expect(after).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('batch rethrows the error of fn, not a listener\'s', () => {
    const s = new Store();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.subscribe(() => {
      throw new Error('listener');
    });
    const fnErr = new Error('fn');
    expect(() =>
      s.batch(() => {
        s.add([el('a')]);
        throw fnErr;
      }),
    ).toThrow(fnErr);
    err.mockRestore();
  });
});

describe('Store: many single-id removals in one batch', () => {
  it('costs the same per id whatever the size of the board', () => {
    const N = 50_000;
    const K = 3_000;
    const s = new Store();
    // Spread out: cards piled on one spot are the worst case of the spatial index, not of the order.
    s.add(Array.from({ length: N }, (_, i) => el(`c${i}`, { x: (i % 250) * 120, y: Math.floor(i / 250) * 120 })));
    const seen = collect(s);
    const victims = s.ids().filter((_, i) => i % 16 === 0).slice(0, K);
    const t0 = performance.now();
    s.batch(() => {
      for (const id of victims) s.remove([id]);
    });
    const ms = performance.now() - t0;
    console.info(`remove ${K} single ids in one batch on ${N} cards: ${ms.toFixed(0)} ms`);
    expect(s.size).toBe(N - K);
    expect(s.ids()).toHaveLength(N - K);
    expect(seen).toHaveLength(1);
    expect(seen[0].removed).toHaveLength(K);
    expect(ms).toBeLessThan(1000);
  });

  it('reads inside the batch see the removals, and a removed id can be added again', () => {
    const s = new Store();
    s.add([el('a'), el('b'), el('c'), el('d')]);
    const seen = collect(s);
    s.batch(() => {
      s.remove(['b']);
      expect(s.ids()).toEqual(['a', 'c', 'd']);
      expect(s.rank('c')).toBe(1);
      s.remove(['a']);
      s.add([el('a')]);
      expect(s.ids()).toEqual(['c', 'd', 'a']);
      s.remove(['d']);
    });
    expect(s.ids()).toEqual(['c', 'a']);
    expect(s.rank('a')).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].removed.map((e) => e.id).sort()).toEqual(['b', 'd']);
  });
});

describe('Store: a write made by a listener', () => {
  it('reaches the listeners after the change that caused it, in the order they were made', () => {
    const s = new Store();
    const seenBy = { a: [] as string[], b: [] as string[] };
    const kind = (c: ChangeSet) => (c.added.length ? `add ${c.added[0].id}` : `update ${c.updated[0].el.id}`);
    s.subscribe((e) => {
      seenBy.a.push(kind(e.change));
      if (e.change.added.some((x) => x.id === 'x')) s.update('x', { x: 5 });
    });
    s.subscribe((e) => seenBy.b.push(kind(e.change)));
    s.add([el('x')]);
    expect(seenBy.a).toEqual(['add x', 'update x']);
    expect(seenBy.b).toEqual(['add x', 'update x']);
    expect(s.get('x')?.x).toBe(5);
  });

  it('keeps a peer fed by a forwarding listener equal to the store', () => {
    const s = new Store();
    const peer = new Store();
    s.subscribe((e) => {
      if (e.change.added.some((x) => x.id === 'x')) s.update('x', { x: 5 });
    });
    s.subscribe((e) => {
      const c = e.change;
      peer.batch(() => {
        peer.remove(c.removed.map((x) => x.id));
        peer.add(c.added.filter((x) => !peer.has(x.id)));
        for (const u of c.updated) peer.update(u.el.id, u.el);
      });
    });
    s.add([el('x'), el('y')]);
    expect(peer.get('x')).toEqual(s.get('x'));
    expect(peer.ids()).toEqual(['x', 'y']);
  });

  it('handles a chain of writes, and a listener that throws after writing', () => {
    const s = new Store();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log: string[] = [];
    s.subscribe((e) => {
      const c = e.change;
      if (c.added[0]?.id === 'a') s.add([el('b')]);
      else if (c.added[0]?.id === 'b') {
        s.add([el('c')]);
        throw new Error('boom');
      }
    });
    s.subscribe((e) => log.push(e.change.added.map((x) => x.id).join()));
    s.add([el('a')]);
    expect(log).toEqual(['a', 'b', 'c']);
    // The store is not stuck in "dispatching".
    s.add([el('d')]);
    expect(log).toEqual(['a', 'b', 'c', 'd']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('Store: lift and add', () => {
  it('a card added while others are lifted ranks below them, and the stage is told to re-sort', () => {
    const s = new Store();
    s.add([el('a'), el('b')]);
    s.lift(['a']);
    const v = s.orderVersion;
    s.add([el('c')]);
    expect(s.rank('c')).toBe(2);
    expect(s.rank('a')).toBe(3);
    expect(s.rank('b')).toBe(1);
    expect(s.orderVersion).toBeGreaterThan(v);
    s.lift([]);
    expect(s.rank('a')).toBe(0);
  });

  it('several lifted cards keep their relative order through an add', () => {
    const s = new Store();
    s.add([el('a'), el('b'), el('c')]);
    s.lift(['c', 'a']);
    s.add([el('d'), el('e')]);
    expect(s.rank('a')).toBe(5);
    expect(s.rank('c')).toBe(6);
    expect(s.rank('d')).toBe(3);
    expect(s.rank('e')).toBe(4);
  });

  it('without a lift an add does not bump orderVersion', () => {
    const s = new Store();
    s.add([el('a')]);
    const v = s.orderVersion;
    s.add([el('b')]);
    expect(s.orderVersion).toBe(v);
  });
});
