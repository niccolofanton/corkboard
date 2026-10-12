import { describe, expect, it } from 'vitest';
import { Atlas, cellsPerPage, cellsPerRow } from '../../src/render/atlas';

const L1 = { pageSize: 2048, cell: 128, gutter: 4 };
const L0 = { pageSize: 1024, cell: 32, gutter: 2 };

function make(spec = L1): { atlas: Atlas<{ id: number }>; created: number[]; destroyed: number[] } {
  const created: number[] = [];
  const destroyed: number[] = [];
  let id = 0;
  const atlas = new Atlas<{ id: number }>(
    spec,
    () => {
      created.push(++id);
      return { id };
    },
    (p) => destroyed.push(p.id),
  );
  return { atlas, created, destroyed };
}

describe('Atlas', () => {
  it('cuts a 2048 page into 225 cells of 128 px with 4 px gutters', () => {
    expect(cellsPerRow(L1)).toBe(15);
    expect(cellsPerPage(L1)).toBe(225);
    expect(cellsPerPage(L0)).toBe(784);
  });

  it('hands out distinct, in-page, gutter-clear cells', () => {
    const { atlas } = make();
    const seen = new Set<string>();
    for (let i = 0; i < 225; i++) {
      const c = atlas.alloc();
      expect(seen.has(`${c.x},${c.y}`)).toBe(false);
      seen.add(`${c.x},${c.y}`);
      // The usable area plus its gutter stays inside the page.
      expect(c.x).toBeGreaterThanOrEqual(4);
      expect(c.y).toBeGreaterThanOrEqual(4);
      expect(c.x + 128 + 4).toBeLessThanOrEqual(2048);
      expect(c.y + 128 + 4).toBeLessThanOrEqual(2048);
    }
    expect(atlas.pageCount).toBe(1);
  });

  it('opens a new page when one is full: 1,000 cards take 5 pages', () => {
    const { atlas, created } = make();
    for (let i = 0; i < 1000; i++) atlas.alloc();
    expect(atlas.pageCount).toBe(5);
    expect(created).toEqual([1, 2, 3, 4, 5]);
    expect(atlas.cellsUsed).toBe(1000);
  });

  it('reuses freed cells before opening a page, and destroys a page whose cells are all cold', () => {
    const { atlas, created, destroyed } = make();
    const cells = Array.from({ length: 226 }, () => atlas.alloc()); // page 1 full + 1 on page 2
    expect(atlas.pageCount).toBe(2);
    // Free one cell on page 1: the next alloc lands there, not on a third page.
    atlas.release(cells[10]);
    const again = atlas.alloc();
    expect(again.page).toBe(cells[10].page);
    expect(created).toHaveLength(2);
    // Free the only cell of page 2: the page goes away.
    expect(atlas.release(cells[225])).toBe(true);
    expect(destroyed).toEqual([2]);
    expect(atlas.pageCount).toBe(1);
  });

  it('clear() destroys every page', () => {
    const { atlas, destroyed } = make(L0);
    for (let i = 0; i < 800; i++) atlas.alloc();
    expect(atlas.pageCount).toBe(2);
    atlas.clear();
    expect(destroyed).toEqual([1, 2]);
    expect(atlas.pageCount).toBe(0);
  });
});
