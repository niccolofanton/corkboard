// TextureManager: owns every GPU texture of the board and the decode worker pool that feeds it.
//
//   L0  ThumbHash cells in a shared 32 px atlas (1024 px pages, no mips)
//   L1  small renditions in 128 px atlas cells (2048 px pages, 4 px gutters, 3 mip levels)
//   L2  medium renditions as an own texture at bucket 256 / 512 (full mip chain)
//   L3  large renditions as an own texture at bucket 1024 / 1600 (close zoom; the stage caps how many cards want one)
//
// Rounded corners (and the card hairline) are baked in the decode worker, so a card is a plain sprite.
// Decoded bitmaps are uploaded on the main thread under a per-frame time budget; atlas cells go in with
// `texSubImage2D` (Pixi has no partial-upload API, so this talks to GL through the renderer's own
// texture system and keeps its bind / unpack-state caches coherent), then the touched pages get
// their mip chain regenerated once per frame.
//
// Texture memory follows what is on screen, not the board size: an LRU over the own textures (and, past
// that, cold L1 cells) keeps the total under `budgetBytes`. Teardown is always deferred (retire.ts).
import { ImageSource, Rectangle, Texture, TextureSource, type WebGLRenderer } from 'pixi.js';
import { Atlas, cellsPerPage, type AtlasCell } from './atlas';
import type { DecodeRequest, WorkerIn, WorkerOut } from './decode.protocol';
import type { Level } from './lod';
import { planEviction, type LruEntry } from './lru';
import { RetireQueue } from './retire';
import type { BoardCard } from './types';

const MIP_FACTOR = 4 / 3;
const L0_SPEC = { pageSize: 1024, cell: 32, gutter: 2 } as const;
const L1_SPEC = { pageSize: 2048, cell: 128, gutter: 4 } as const;
const INFLIGHT_PER_WORKER = 4;
// A failed fetch / decode is not retried for this long (a 404 for an undecodable large rendition must not loop).
const RETRY_AFTER_MS = 30_000;
// Requests for cards that are not on screen (the ThumbHash prefetch) carry at least this distance and
// always queue behind everything that is.
export const FAR_DIST = 1e6;
const L1_PAGE_BYTES = L1_SPEC.pageSize ** 2 * 4 * MIP_FACTOR;

export interface TextureManagerOptions {
  budgetBytes: number;
  workers: number;
  // Bake corners in a software canvas in the workers (default false: measured ~2x slower to load).
  softCanvas?: boolean;
  // CSS colour of the 1 px card hairline baked into L1+ textures ('' = none).
  border?: string;
  // Completed renders to wait before destroying a retired texture (see retire.ts).
  retireDelay?: number;
  // Called whenever a teardown is parked: the stage rebuilds Pixi's batches before the next render so no
  // batch still lists the retired texture (see retire.ts for why).
  onRetire?: () => void;
  // The decoded pixels are always uploaded premultiplied (see uploadCell).
  onWake: () => void;
}

interface Page {
  source: TextureSource;
  bytes: number;
  mips: boolean;
  dirty: boolean;
  // Belongs to an atlas replaced by reset(): already out of the byte count.
  dead?: boolean;
}

interface CardTex {
  tex: (Texture | null)[];
  cell: (AtlasCell<Page> | null)[];
  // Own textures (levels 2 and 3): long side (texels) that is resident (0 = none), whether the source
  // ran out of pixels before the requested bucket (a 480 px rendition never fills a 512 bucket), bytes.
  ownLong: number[];
  ownCapped: boolean[];
  ownBytes: number[];
  // Last time the card was on screen, and last time it was on screen wanting an own texture.
  last: number;
  last2: number;
}

interface Req {
  rid: number;
  card: BoardCard;
  level: Level;
  maxLong: number;
  dist: number;
  inflight: boolean;
  worker: number;
  cancelled: boolean;
}

interface Decoded {
  req: Req;
  bitmap: ImageBitmap;
  w: number;
  h: number;
  fetched: number;
  decodeMs: number;
}

export interface WantedItem {
  card: BoardCard;
  level: Level;
  // Screen distance from the viewport centre: the priority (lower first).
  dist: number;
  // Own levels only: the bucket (long side, texels).
  bucket?: number;
}

// Pixi internals the partial upload leans on (all present in 8.22; pinned in package.json).
interface GlTextureSystemInternals {
  getGlSource(source: TextureSource): { target: number; texture: WebGLTexture };
  initSource(source: TextureSource): void;
  _premultiplyAlpha: boolean;
  _activateLocation(location: number): void;
  _setBoundTexture(location: number, source: TextureSource | null): void;
}

const key = (card: BoardCard, level: Level): number => card.id * 4 + level;
const isOwn = (level: Level): level is 2 | 3 => level >= 2;

export class TextureManager {
  private readonly texSys: GlTextureSystemInternals;
  private readonly gl: WebGL2RenderingContext;
  private readonly workers: Worker[] = [];
  private readonly workerLoad: number[] = [];
  private atlas0: Atlas<Page>;
  private atlas1: Atlas<Page>;
  private readonly cards = new Map<number, CardTex>();
  private readonly reqs = new Map<number, Req>(); // by rid
  private readonly reqByKey = new Map<number, Req>();
  private readonly failedAt = new Map<number, number>();
  private queue: Req[] = [];
  private decoded: Decoded[] = [];
  // Teardown that must wait until the frames that may still draw the old texture have rendered.
  private readonly retire: RetireQueue;
  // Cards whose texture was just evicted: the stage must re-point their sprites before the next draw.
  private evicted: number[] = [];
  private rid = 1;
  private inflight = 0;
  private pageBytes = 0;
  private ownBytes = 0;
  private overSince = 0;
  private border: string;
  readonly stats = {
    uploads: 0,
    uploadFrames: 0,
    uploadMsTotal: 0,
    uploadMsMax: 0,
    uploadsLastFrame: 0,
    uploadMsLastFrame: 0,
    decodes: 0,
    decodeMsTotal: 0,
    fetchedBytes: 0,
    cancelled: 0,
    failed: 0,
    evictedL2: 0,
    evictedL3: 0,
    evictedL1: 0,
    overBudgetMsMax: 0,
    peakBytes: 0,
  };

  constructor(
    renderer: WebGLRenderer,
    private readonly opts: TextureManagerOptions,
  ) {
    this.texSys = renderer.texture as unknown as GlTextureSystemInternals;
    this.gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
    this.retire = new RetireQueue(opts.retireDelay ?? 2);
    this.border = opts.border ?? '';
    this.atlas0 = this.makeAtlas0();
    this.atlas1 = this.makeAtlas1();
    this.spawnWorkers(opts.workers);
  }

  private makeAtlas0(): Atlas<Page> {
    return new Atlas<Page>(
      L0_SPEC,
      () => this.createPage(L0_SPEC.pageSize, false, 'l0-page'),
      (p) => this.destroyPage(p),
    );
  }
  private makeAtlas1(): Atlas<Page> {
    return new Atlas<Page>(
      L1_SPEC,
      () => this.createPage(L1_SPEC.pageSize, true, 'l1-page'),
      (p) => this.destroyPage(p),
    );
  }

  private spawnWorkers(n: number): void {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerOut>) => this.onWorker(i, e.data);
      w.onerror = (e) => console.error('[corkboard] decode worker error', e.message);
      this.workers.push(w);
      this.workerLoad.push(0);
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────
  get totalBytes(): number {
    return this.pageBytes + this.ownBytes;
  }
  get workerCount(): number {
    return this.workers.length;
  }
  get pendingWork(): boolean {
    return this.decoded.length > 0;
  }
  get queued(): number {
    return this.queue.length;
  }
  get inflightCount(): number {
    return this.inflight;
  }
  get retiredPending(): number {
    return this.retire.size;
  }
  pageCount(): { l0: number; l1: number } {
    return { l0: this.atlas0.pageCount, l1: this.atlas1.pageCount };
  }
  ownCount(level: 2 | 3): number {
    let n = 0;
    for (const c of this.cards.values()) if (c.tex[level]) n++;
    return n;
  }
  l2Count(): number {
    return this.ownCount(2);
  }
  l3Count(): number {
    return this.ownCount(3);
  }

  // Where the bytes are: pages, own textures, and the share of the own bytes that is pinned (on screen).
  breakdown(): {
    pageBytes: number;
    l2Bytes: number;
    l3Bytes: number;
    pinnedBytes: number;
    pinned: number;
  } {
    let pinned = 0;
    let pinnedN = 0;
    let l2 = 0;
    let l3 = 0;
    for (const [id, c] of this.cards) {
      for (const lv of [2, 3] as const) {
        if (!c.tex[lv]) continue;
        if (lv === 2) l2 += c.ownBytes[2];
        else l3 += c.ownBytes[3];
        if (this.keep(id, lv)) {
          pinned += c.ownBytes[lv];
          pinnedN++;
        }
      }
    }
    return {
      pageBytes: this.pageBytes,
      l2Bytes: l2,
      l3Bytes: l3,
      pinnedBytes: pinned,
      pinned: pinnedN,
    };
  }

  // False while the manager is at or past 85 % of its budget: requesting more for cards that are NOT on
  // screen would only make the next eviction pass drop it again (a fetch / evict loop that never parks).
  hasHeadroom(): boolean {
    return this.totalBytes <= this.opts.budgetBytes * 0.85;
  }

  has(card: BoardCard, level: Level): boolean {
    return !!this.cards.get(card.id)?.tex[level];
  }

  // The best resident texture for `desired`: the level itself, else the closest sharper level, else
  // the closest blurrier one.
  best(card: BoardCard, desired: Level): { tex: Texture; level: Level } | null {
    const ct = this.cards.get(card.id);
    if (!ct) return null;
    for (let l = desired; l <= 3; l++) {
      const t = ct.tex[l];
      if (t) return { tex: t, level: l as Level };
    }
    for (let l = desired - 1; l >= 0; l--) {
      const t = ct.tex[l];
      if (t) return { tex: t, level: l as Level };
    }
    return null;
  }

  // `needsOwn`: the card is on screen big enough to want an own texture (L2 / L3).
  touch(card: BoardCard, now: number, needsOwn: boolean): void {
    const ct = this.cards.get(card.id);
    if (!ct) return;
    ct.last = now;
    if (needsOwn) ct.last2 = now;
  }

  private urlOf(card: BoardCard, level: Level): string | undefined {
    return level === 1
      ? card.l1Url
      : level === 2
        ? card.l2Url
        : level === 3
          ? card.l3Url
          : undefined;
  }

  // ── Requests ───────────────────────────────────────────────────────────────
  // Replaces the wanted set: new items are queued, queued items no longer wanted are dropped and
  // in-flight ones are cancelled.
  setWanted(items: WantedItem[], now = performance.now()): void {
    const wanted = new Set<number>();
    for (const it of items) {
      const k = key(it.card, it.level);
      const ct = this.cards.get(it.card.id);
      const resident = ct?.tex[it.level];
      const need2 =
        isOwn(it.level) && it.bucket
          ? !ct?.ownCapped[it.level] && (ct?.ownLong[it.level] ?? 0) < it.bucket
          : false;
      if (resident && !need2) continue;
      // Not requestable: no source yet (its URL has not arrived), or a recent failure.
      if (it.level === 0 ? !it.card.thumbhash : !this.urlOf(it.card, it.level)) continue;
      const failed = this.failedAt.get(k);
      if (failed !== undefined) {
        if (now - failed < RETRY_AFTER_MS) continue;
        this.failedAt.delete(k);
      }
      wanted.add(k);
      const existing = this.reqByKey.get(k);
      if (existing) {
        existing.dist = it.dist;
        continue;
      }
      const maxLong = it.level === 0 ? 32 : it.level === 1 ? L1_SPEC.cell : (it.bucket ?? 512);
      const req: Req = {
        rid: this.rid++,
        card: it.card,
        level: it.level,
        maxLong,
        dist: it.dist,
        inflight: false,
        worker: -1,
        cancelled: false,
      };
      this.reqs.set(req.rid, req);
      this.reqByKey.set(k, req);
      this.queue.push(req);
    }
    // Drop what is no longer wanted.
    if (this.reqByKey.size > wanted.size) {
      for (const [k, req] of this.reqByKey) {
        if (wanted.has(k)) continue;
        this.reqByKey.delete(k);
        this.cancelReq(req);
      }
      this.queue = this.queue.filter((r) => this.reqs.has(r.rid) && !r.cancelled);
    }
    this.pump();
  }

  private cancelReq(req: Req): void {
    if (req.inflight) {
      req.cancelled = true;
      const msg: WorkerIn = { op: 'cancel', rid: req.rid };
      this.workers[req.worker].postMessage(msg);
      this.stats.cancelled++;
    } else {
      this.reqs.delete(req.rid);
    }
  }

  private pump(): void {
    const cap = this.workers.length * INFLIGHT_PER_WORKER;
    if (this.inflight >= cap || this.queue.length === 0) return;
    // On-screen cards first; among them the lower level first (cheap, gives a first paint), then the
    // nearest to the viewport centre. After a context loss this restores the view in viewport order.
    this.queue.sort(
      (a, b) =>
        Number(a.dist >= FAR_DIST) - Number(b.dist >= FAR_DIST) ||
        a.level - b.level ||
        a.dist - b.dist,
    );
    while (this.inflight < cap && this.queue.length > 0) {
      const req = this.queue.shift() as Req;
      // Least-loaded worker.
      let wi = 0;
      for (let i = 1; i < this.workers.length; i++) {
        if (this.workerLoad[i] < this.workerLoad[wi]) wi = i;
      }
      req.inflight = true;
      req.worker = wi;
      this.workerLoad[wi]++;
      this.inflight++;
      const card = req.card;
      const msg: DecodeRequest = {
        op: 'load',
        rid: req.rid,
        level: req.level,
        hash: req.level === 0 ? card.thumbhash : undefined,
        url: this.urlOf(card, req.level),
        maxLong: req.maxLong,
        soft: this.opts.softCanvas,
        radiusWorld: card.radius,
        worldLong: Math.max(card.w, card.h),
        border: req.level === 0 ? undefined : this.border || undefined,
      };
      this.workers[wi].postMessage(msg);
    }
  }

  private onWorker(wi: number, m: WorkerOut): void {
    const req = this.reqs.get(m.rid);
    this.workerLoad[wi] = Math.max(0, this.workerLoad[wi] - 1);
    if (req) {
      this.inflight = Math.max(0, this.inflight - 1);
      this.reqs.delete(req.rid);
      if (this.reqByKey.get(key(req.card, req.level)) === req) {
        this.reqByKey.delete(key(req.card, req.level));
      }
    }
    if (m.op === 'fail') {
      if (!m.aborted) {
        this.stats.failed++;
        if (req) this.failedAt.set(key(req.card, req.level), performance.now());
        console.warn('[corkboard] decode failed', m.reason);
      }
      this.pump();
      return;
    }
    if (!req || req.cancelled) {
      m.bitmap.close();
      this.pump();
      return;
    }
    this.stats.decodes++;
    this.stats.decodeMsTotal += m.decodeMs;
    this.stats.fetchedBytes += m.fetched;
    this.decoded.push({
      req,
      bitmap: m.bitmap,
      w: m.w,
      h: m.h,
      fetched: m.fetched,
      decodeMs: m.decodeMs,
    });
    this.pump();
    this.opts.onWake();
  }

  // ── Uploads (called once per frame, before render) ─────────────────────────
  // Uploads decoded bitmaps until `budgetMs` is spent (at least one). Returns the ids of the cards
  // that got a new texture.
  frame(budgetMs: number, now: number): number[] {
    const changed: number[] = [];
    const t0 = performance.now();
    let n = 0;
    while (this.decoded.length > 0) {
      const d = this.decoded.shift() as Decoded;
      this.upload(d, now);
      changed.push(d.req.card.id);
      n++;
      if (performance.now() - t0 >= budgetMs) break;
    }
    if (n > 0) {
      for (const p of [...this.atlas1.pageList]) this.flushMips(p);
      const ms = performance.now() - t0;
      const s = this.stats;
      s.uploads += n;
      s.uploadFrames++;
      s.uploadMsTotal += ms;
      s.uploadMsMax = Math.max(s.uploadMsMax, ms);
      s.uploadsLastFrame = n;
      s.uploadMsLastFrame = ms;
      this.enforceBudget(now);
    } else {
      this.stats.uploadsLastFrame = 0;
      this.stats.uploadMsLastFrame = 0;
    }
    return changed;
  }

  takeEvicted(): number[] {
    const e = this.evicted;
    this.evicted = [];
    return e;
  }

  // Call after every completed render (see retire.ts), and `flushRetired` when the loop parks.
  afterRender(): void {
    this.retire.afterRender();
  }
  flushRetired(): void {
    this.retire.flushIdle();
  }

  private retireTexture(t: Texture, destroySource: boolean): void {
    this.retire.push(() => t.destroy(destroySource));
    this.opts.onRetire?.();
  }

  private releaseCell(atlas: Atlas<Page>, cell: AtlasCell<Page>): void {
    this.retire.push(() => atlas.release(cell));
    this.opts.onRetire?.();
  }

  private upload(d: Decoded, now: number): void {
    const { req, bitmap, w, h } = d;
    const card = req.card;
    const ct = this.cardTex(card.id);
    ct.last = now;
    const level = req.level;
    if (isOwn(level)) {
      ct.last2 = now;
      const source = new ImageSource({
        resource: bitmap,
        width: w,
        height: h,
        alphaMode: 'premultiply-alpha-on-upload',
        autoGenerateMipmaps: true,
        scaleMode: 'linear',
        label: `l${level}`,
      });
      // Uploads now (and builds the mip chain), inside the budgeted step rather than at first draw.
      this.texSys.initSource(source);
      bitmap.close();
      const old = ct.tex[level];
      if (old) {
        this.retireTexture(old, true);
        this.ownBytes -= ct.ownBytes[level];
      }
      ct.tex[level] = new Texture({ source });
      ct.ownLong[level] = Math.max(w, h);
      ct.ownCapped[level] = ct.ownLong[level] < req.maxLong;
      ct.ownBytes[level] = w * h * 4 * MIP_FACTOR;
      this.ownBytes += ct.ownBytes[level];
      return;
    }
    const atlas = level === 0 ? this.atlas0 : this.atlas1;
    const prev = ct.cell[level];
    if (prev) {
      const old = ct.tex[level];
      if (old) this.retireTexture(old, false);
      this.releaseCell(atlas, prev);
      ct.cell[level] = null;
      ct.tex[level] = null;
    }
    const cell = atlas.alloc();
    this.uploadCell(cell.page, cell.x, cell.y, bitmap);
    bitmap.close();
    cell.page.dirty = true;
    ct.cell[level] = cell;
    ct.tex[level] = new Texture({
      source: cell.page.source,
      frame: new Rectangle(cell.x, cell.y, w, h),
    });
  }

  private cardTex(id: number): CardTex {
    let ct = this.cards.get(id);
    if (!ct) {
      ct = {
        tex: [null, null, null, null],
        cell: [null, null],
        ownLong: [0, 0, 0, 0],
        ownCapped: [false, false, false, false],
        ownBytes: [0, 0, 0, 0],
        last: 0,
        last2: 0,
      };
      this.cards.set(id, ct);
    }
    return ct;
  }

  // ── Card lifecycle ─────────────────────────────────────────────────────────
  // Drops every texture and request of one card (the element was removed, or its media / size changed
  // so what is resident is stale). The caller re-points the card's sprite first (it must not draw the
  // old texture again): teardown is deferred like every other.
  forget(id: number): void {
    for (let level = 0; level < 4; level++) {
      const k = id * 4 + level;
      const req = this.reqByKey.get(k);
      if (req) {
        this.reqByKey.delete(k);
        this.cancelReq(req);
        this.queue = this.queue.filter((r) => r !== req);
      }
      this.failedAt.delete(k);
    }
    const ct = this.cards.get(id);
    if (!ct) return;
    this.cards.delete(id);
    for (let level = 0; level < 4; level++) {
      const t = ct.tex[level];
      if (!t) continue;
      if (level >= 2) {
        this.retireTexture(t, true);
        this.ownBytes -= ct.ownBytes[level];
      } else {
        this.retireTexture(t, false);
        const cell = ct.cell[level as 0 | 1];
        if (cell) this.releaseCell(level === 0 ? this.atlas0 : this.atlas1, cell);
      }
    }
    // Bitmaps of this card that are decoded but not uploaded yet.
    this.decoded = this.decoded.filter((d) => {
      if (d.req.card.id !== id) return true;
      d.bitmap.close();
      return false;
    });
  }

  // The hairline colour changed with the theme: every texture has it baked in.
  setBorder(border: string): void {
    if (border === this.border) return;
    this.border = border;
  }

  // ── GL ─────────────────────────────────────────────────────────────────────
  private createPage(size: number, mips: boolean, label: string): Page {
    const source = new TextureSource({
      width: size,
      height: size,
      format: 'rgba8unorm',
      alphaMode: 'premultiply-alpha-on-upload',
      autoGenerateMipmaps: false,
      // Limited mips: the gutters keep 3 levels clean (128 -> 64 -> 32 px cells).
      mipLevelCount: mips ? 3 : 1,
      scaleMode: 'linear',
      mipmapFilter: mips ? 'linear' : 'nearest',
      addressMode: 'clamp-to-edge',
      label,
    });
    // Allocates the (empty) storage now.
    this.texSys.initSource(source);
    const bytes = size * size * 4 * (mips ? MIP_FACTOR : 1);
    this.pageBytes += bytes;
    return { source, bytes, mips, dirty: false };
  }

  private destroyPage(p: Page): void {
    if (!p.dead) this.pageBytes -= p.bytes;
    p.source.destroy();
  }

  private bindPage(p: Page): { target: number } {
    const gl = this.gl;
    const sys = this.texSys;
    const glTex = sys.getGlSource(p.source);
    sys._activateLocation(0);
    gl.bindTexture(glTex.target, glTex.texture);
    sys._setBoundTexture(0, p.source);
    return glTex;
  }

  private uploadCell(p: Page, x: number, y: number, bitmap: ImageBitmap): void {
    const gl = this.gl;
    const glTex = this.bindPage(p);
    // Canvas-born bitmaps are premultiplied, so upload them as such: no conversion, no fringes.
    if (!this.texSys._premultiplyAlpha) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      this.texSys._premultiplyAlpha = true;
    }
    gl.texSubImage2D(glTex.target, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  }

  private flushMips(p: Page): void {
    if (!p.dirty) return;
    p.dirty = false;
    if (!p.mips) return;
    const glTex = this.bindPage(p);
    this.gl.generateMipmap(glTex.target);
  }

  // ── Budget ─────────────────────────────────────────────────────────────────
  // Frees own textures, then cold L1 cells, least recently seen first, until under budget. `keep`
  // says which textures are in use right now (never evicted): an own texture only while its card is on
  // screen and big enough to want that level, an L1 while the card is on screen.
  keep: (id: number, level: 1 | 2 | 3) => boolean = () => false;

  enforceBudget(now: number): void {
    const total = this.totalBytes;
    this.stats.peakBytes = Math.max(this.stats.peakBytes, total);
    if (total <= this.opts.budgetBytes) {
      if (this.overSince) {
        this.stats.overBudgetMsMax = Math.max(this.stats.overBudgetMsMax, now - this.overSince);
        this.overSince = 0;
      }
      return;
    }
    if (!this.overSince) this.overSince = now;
    // Own textures first (the big ones), least recently on screen first. An entry is (card, level).
    const own: LruEntry[] = [];
    for (const [id, ct] of this.cards) {
      for (const lv of [2, 3] as const) {
        if (ct.tex[lv]) {
          own.push({
            id: id * 4 + lv,
            last: ct.last2,
            bytes: ct.ownBytes[lv],
            pinned: this.keep(id, lv),
          });
        }
      }
    }
    for (const k of planEviction(own, total, this.opts.budgetBytes)) {
      const id = k >> 2;
      const lv = (k & 3) as 2 | 3;
      const ct = this.cards.get(id) as CardTex;
      this.retireTexture(ct.tex[lv] as Texture, true);
      ct.tex[lv] = null;
      this.ownBytes -= ct.ownBytes[lv];
      ct.ownBytes[lv] = 0;
      ct.ownLong[lv] = 0;
      ct.ownCapped[lv] = false;
      this.evicted.push(id);
      if (lv === 2) this.stats.evictedL2++;
      else this.stats.evictedL3++;
    }
    // Then cold L1 cells. A cell only frees bytes once its whole page is empty (and after the frame),
    // so each one counts as its share of a page: one pass must not strip every cold cell.
    if (this.totalBytes > this.opts.budgetBytes * 0.85) {
      const perCell = L1_PAGE_BYTES / cellsPerPage(L1_SPEC);
      const l1: LruEntry[] = [];
      for (const [id, ct] of this.cards) {
        if (ct.cell[1]) l1.push({ id, last: ct.last, bytes: perCell, pinned: this.keep(id, 1) });
      }
      for (const id of planEviction(l1, this.totalBytes, this.opts.budgetBytes)) {
        const ct = this.cards.get(id) as CardTex;
        this.retireTexture(ct.tex[1] as Texture, false);
        ct.tex[1] = null;
        this.releaseCell(this.atlas1, ct.cell[1] as AtlasCell<Page>);
        ct.cell[1] = null;
        this.evicted.push(id);
        this.stats.evictedL1++;
      }
    }
    if (this.totalBytes <= this.opts.budgetBytes && this.overSince) {
      this.stats.overBudgetMsMax = Math.max(this.stats.overBudgetMsMax, now - this.overSince);
      this.overSince = 0;
    }
  }

  // The GL context was lost and restored (or a frame failed): every texture is gone. Forget them all;
  // the stage re-requests what is on screen (from the HTTP cache) in viewport order.
  reset(): void {
    for (const r of this.reqs.values()) {
      if (r.inflight) this.workers[r.worker].postMessage({ op: 'cancel', rid: r.rid } as WorkerIn);
    }
    this.reqs.clear();
    this.reqByKey.clear();
    this.failedAt.clear();
    this.queue = [];
    this.inflight = 0;
    this.workerLoad.fill(0);
    for (const d of this.decoded) d.bitmap.close();
    this.decoded = [];
    // Sprites still point at the old textures until the stage re-points them and the next frames have
    // rendered, so tear the old ones down only then (and never touch the new atlases doing it).
    const oldTextures: [Texture, boolean][] = [];
    for (const ct of this.cards.values()) {
      ct.tex.forEach((t, level) => t && oldTextures.push([t, level >= 2]));
    }
    const old0 = this.atlas0;
    const old1 = this.atlas1;
    for (const a of [old0, old1]) for (const p of a.pageList) p.dead = true;
    this.atlas0 = this.makeAtlas0();
    this.atlas1 = this.makeAtlas1();
    this.cards.clear();
    this.retire.push(() => {
      for (const [t, own] of oldTextures) t.destroy(own);
      old0.clear();
      old1.clear();
    });
    this.opts.onRetire?.();
    this.evicted = [];
    this.pageBytes = 0;
    this.ownBytes = 0;
    this.overSince = 0;
  }

  dispose(): void {
    this.reset();
    this.retire.flushAll();
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }
}
