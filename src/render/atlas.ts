// Fixed-cell texture atlas bookkeeping (no GL here: see textures.ts for the GPU side).
//
// A page is a square of `pageSize` px cut into `cell + 2 * gutter` px strides, so every cell has a
// transparent gutter that keeps bilinear taps and the first mip levels from bleeding between
// neighbours. 2048 px pages with 128 px cells and a 4 px gutter hold 15 x 15 = 225 cells.
export interface AtlasSpec {
  pageSize: number;
  cell: number;
  gutter: number;
}

export interface AtlasCell<P> {
  page: P;
  // Index inside the page.
  index: number;
  // Top-left of the cell's usable area (gutter already skipped), in page pixels.
  x: number;
  y: number;
  // The cell held another occupant before: its pixels are still in the page, so an upload that does not
  // cover the whole cell has to clear the rest.
  reused: boolean;
}

interface PageState<P> {
  page: P;
  used: number;
  free: number[];
  // Per cell: handed out at least once (the page starts out empty, so a cell never used needs no clearing).
  touched: Uint8Array;
}

export function cellsPerRow(spec: AtlasSpec): number {
  return Math.floor(spec.pageSize / (spec.cell + 2 * spec.gutter));
}
export function cellsPerPage(spec: AtlasSpec): number {
  const n = cellsPerRow(spec);
  return n * n;
}

export class Atlas<P> {
  readonly spec: AtlasSpec;
  private readonly perRow: number;
  private readonly stride: number;
  private pages: PageState<P>[] = [];

  constructor(
    spec: AtlasSpec,
    private readonly createPage: () => P,
    private readonly destroyPage: (page: P) => void,
  ) {
    this.spec = spec;
    this.stride = spec.cell + 2 * spec.gutter;
    this.perRow = cellsPerRow(spec);
  }

  get pageCount(): number {
    return this.pages.length;
  }
  get cellsUsed(): number {
    return this.pages.reduce((n, p) => n + p.used, 0);
  }
  get pageList(): P[] {
    return this.pages.map((p) => p.page);
  }

  alloc(): AtlasCell<P> {
    let st = this.pages.find((p) => p.free.length > 0);
    if (!st) {
      const n = this.perRow * this.perRow;
      // Highest index first, so `pop()` hands cells out in reading order.
      const free: number[] = [];
      for (let i = n - 1; i >= 0; i--) free.push(i);
      st = { page: this.createPage(), used: 0, free, touched: new Uint8Array(n) };
      this.pages.push(st);
    }
    const index = st.free.pop() as number;
    st.used++;
    const reused = st.touched[index] === 1;
    st.touched[index] = 1;
    const col = index % this.perRow;
    const row = Math.floor(index / this.perRow);
    return {
      page: st.page,
      index,
      x: col * this.stride + this.spec.gutter,
      y: row * this.stride + this.spec.gutter,
      reused,
    };
  }

  // Frees a cell; a page with no cell left is destroyed (all its cells went cold).
  release(cell: AtlasCell<P>): boolean {
    const i = this.pages.findIndex((p) => p.page === cell.page);
    if (i < 0) return false;
    const st = this.pages[i];
    st.free.push(cell.index);
    st.used--;
    if (st.used === 0) {
      this.pages.splice(i, 1);
      this.destroyPage(st.page);
      return true;
    }
    return false;
  }

  clear(): void {
    for (const st of this.pages) this.destroyPage(st.page);
    this.pages = [];
  }
}
