// The embed layer of a corkboard: poster resolution and the live iframes of `embed` cards.
//
//   poster   always. The card is a textured sprite like any other (generated tile, provider thumbnail or
//            the host's picture), through the LOD pipeline. No DOM.
//   live     an iframe in a DOM layer over the canvas, laid out at the card's world size and moved with the
//            camera as one CSS matrix (geometry.ts), only for the few cards the policy picks (policy.ts):
//            big enough or selected, camera still, at most `maxLive` at a time. The poster stays under it
//            and the iframe fades in when it has loaded. Leaving the live state destroys the iframe.
//   interact the iframe takes pointer events (double-click or Enter on a selected embed). A "Done" button,
//            a click outside the iframe or Esc ends it. Until then the canvas keeps pan, zoom, select and
//            drag: the iframe has `pointer-events: none`.
//
// What goes in the iframe (sandbox, allow list) is decided at mount time by sandbox.ts, never stored.
import type { Camera } from '../math';
import type { Stage } from '../render/stage';
import type { Store, StoreEvent } from '../store';
import type { Theme } from '../render/theme';
import { elementBox } from '../interact/geometry';
import type { Element, ElementId, EmbedResolution, EmbedSource } from '../types';
import { DEFAULT_RESOLUTION, embedPlacement } from './geometry';
import {
  MAX_LIVE_DESKTOP,
  MAX_LIVE_TOUCH,
  MIN_LIVE_H,
  MIN_LIVE_SCALE,
  MIN_LIVE_W,
  planLive,
  type PolicyCard,
} from './policy';
import { fetchPoster } from './poster';
import type { EmbedProvider } from './providers';
import {
  baseResolved,
  canGoLive,
  mergeResolved,
  sameEmbed,
  type EmbedResolver,
  type ResolvedEmbed,
} from './resolve';
import { iframeSpecFor, type IframeSpec } from './sandbox';
import { drawTile, tileSpec } from './tile';

export interface EmbedOptions {
  // Live iframes at once on a mouse / pen device (default 4).
  maxLive?: number;
  // ... and on a touch device (default 1).
  maxLiveTouch?: number;
  // A card goes live when it is at least this big on screen, in CSS px (default 320 wide x 200 high), or
  // selected. A number is the width; the height keeps the 320:200 ratio.
  minLivePx?: number | { w: number; h: number };
  // Async lookup for what the browser cannot know: oEmbed thumbnails and titles, og:image, screenshots,
  // and whether the page may be framed at all. Runs on a server of yours. See EmbedResolver.
  resolve?: EmbedResolver;
  // Give up on `resolve` after this long and use what the URL says (default 4000 ms).
  resolveTimeoutMs?: number;
  // The virtual screen a live page is laid out at (default '720p'); a card's `embed.resolution` wins.
  resolution?: EmbedResolution;
  // Keep `allow-same-origin` in the sandbox of arbitrary (non-provider) URLs (default true). Many sites break
  // without their own cookies and storage, but the frame then keeps its real origin across the navigations
  // it makes. false: those frames get an opaque origin. Providers and snippets are not affected.
  arbitrarySameOrigin?: boolean;
}

export interface EmbedEvents {
  // Interact mode began (`active: true`) or ended on an embed card.
  embedInteract: { id: ElementId; active: boolean };
  // A card's iframe was mounted or destroyed.
  embedLive: { id: ElementId; live: boolean };
  // The card's embed was resolved. `poster` is a URL worth persisting (the host's own or a provider
  // thumbnail), absent for a generated tile or any blob URL this layer made (they die with the page).
  embedResolved: {
    id: ElementId;
    provider: EmbedProvider;
    frameable: boolean;
    aspect?: number;
    title?: string;
    poster?: string;
  };
}

export interface EmbedLayerDeps {
  // The DOM layer shared with the other overlays (covers the canvas, `pointer-events: none`).
  root: HTMLElement;
  // The board's host: Enter on it enters interact mode.
  host: HTMLElement;
  store: Store;
  stage: Stage;
  emit<K extends keyof EmbedEvents>(type: K, payload: EmbedEvents[K]): void;
}

interface Entry {
  embed: EmbedSource;
  info: ResolvedEmbed;
  // `resolve` has answered (or there is none): the card knows if it can go live.
  ready: boolean;
  spec: IframeSpec | null;
  token: number;
  // The blob URL of the poster this layer made (photo or tile), written to media.src.
  ownUrl: string | null;
  ownKind: 'photo' | 'tile' | null;
  // Our earlier posters the element may still carry (the embed changed under it).
  stale: Set<string>;
  initialAspect: number;
  lastUsed: number;
}

interface Frame {
  wrapper: HTMLElement;
  iframe: HTMLIFrameElement;
  loaded: boolean;
  w: number;
  h: number;
  transform: string;
  z: number;
}

const STYLE_ID = 'cb-embed-styles';
const CSS = `
.cb-embed{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden;background:#fff;opacity:0;pointer-events:none;transition:opacity .2s ease}
.cb-embed[data-ready]{opacity:1}
.cb-embed iframe{position:absolute;left:0;top:0;width:100%;height:100%;border:0;display:block;pointer-events:none;color-scheme:normal}
.cb-embed[data-interact]{pointer-events:auto}
.cb-embed[data-interact] iframe{pointer-events:auto}
.cb-embed-done{position:absolute;left:0;top:0;z-index:2147483647;pointer-events:auto;font:600 12px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff;background:rgba(20,20,22,.9);border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:8px 14px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);display:none}
.cb-embed-done:hover{background:rgba(48,48,52,.95)}
.cb-embed-done:focus-visible{outline:2px solid #6aa6ff;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.cb-embed{transition:none}}
`;

const DONE_MARGIN = 10;
// Leave the iframe's pixels alone this long after a poster swap before revoking the old blob.
const REVOKE_DELAY_MS = 15000;

const normMinLive = (m: EmbedOptions['minLivePx']): { w: number; h: number } =>
  m === undefined
    ? { w: MIN_LIVE_W, h: MIN_LIVE_H }
    : typeof m === 'number'
      ? { w: m, h: (m * MIN_LIVE_H) / MIN_LIVE_W }
      : m;

export class EmbedLayer {
  private readonly root: HTMLElement;
  private readonly host: HTMLElement;
  private readonly store: Store;
  private readonly stage: Stage;
  private readonly emit: EmbedLayerDeps['emit'];
  private readonly doc: Document;
  private readonly entries = new Map<ElementId, Entry>();
  private readonly frames = new Map<ElementId, Frame>();
  private readonly done: HTMLButtonElement;
  private readonly cleanups: (() => void)[] = [];
  // Pending revokes of retired poster blobs: timer -> URL (dispose revokes the rest at once).
  private readonly timers = new Map<ReturnType<typeof setTimeout>, string>();
  private readonly appOrigin: string | undefined;
  private opts: Required<Pick<EmbedOptions, 'maxLive' | 'maxLiveTouch' | 'resolveTimeoutMs'>> & {
    minLive: { w: number; h: number };
    resolve?: EmbedResolver;
    resolution: EmbedResolution;
    arbitrarySameOrigin: boolean;
  };
  private selected = new Set<ElementId>();
  private touch = false;
  private moving = false;
  private planDirty = false;
  private interactId: ElementId | null = null;
  // Double-click on a card too small to mount (zoomed far out): fly to it, then interact.
  private pendingInteract: ElementId | null = null;
  private clock = 0;
  private disposed = false;

  constructor(deps: EmbedLayerDeps, options: EmbedOptions = {}) {
    this.host = deps.host;
    this.store = deps.store;
    this.stage = deps.stage;
    this.emit = deps.emit;
    this.doc = deps.root.ownerDocument;
    this.appOrigin = typeof location !== 'undefined' ? location.origin : undefined;
    this.opts = {
      maxLive: options.maxLive ?? MAX_LIVE_DESKTOP,
      maxLiveTouch: options.maxLiveTouch ?? MAX_LIVE_TOUCH,
      resolveTimeoutMs: options.resolveTimeoutMs ?? 4000,
      minLive: normMinLive(options.minLivePx),
      resolve: options.resolve,
      resolution: options.resolution ?? DEFAULT_RESOLUTION,
      arbitrarySameOrigin: options.arbitrarySameOrigin ?? true,
    };

    if (!this.doc.getElementById(STYLE_ID)) {
      const style = this.doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      this.doc.head.appendChild(style);
    }
    this.root = this.doc.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    deps.root.appendChild(this.root);

    this.done = this.doc.createElement('button');
    this.done.type = 'button';
    this.done.className = 'cb-embed-done';
    this.done.textContent = 'Done';
    this.done.setAttribute('aria-label', 'Done interacting with the embed');
    // The board listens on its host: nothing the button gets may reach it.
    for (const t of ['pointerdown', 'pointerup', 'dblclick', 'wheel', 'keydown'] as const) {
      this.done.addEventListener(t, (e) => {
        if (t === 'keydown' && (e as KeyboardEvent).key === 'Escape') return;
        e.stopPropagation();
      });
    }
    this.done.addEventListener('click', () => this.exitInteract());
    this.root.appendChild(this.done);

    const onDown = (e: PointerEvent): void => {
      if (this.interactId === null) return;
      const f = this.frames.get(this.interactId);
      const t = e.target as Node | null;
      if (f && t && (f.wrapper.contains(t) || this.done.contains(t))) return;
      this.exitInteract();
    };
    const onKeyDoc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && this.interactId !== null) {
        e.stopPropagation();
        this.exitInteract();
      }
    };
    const onKeyHost = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.target !== this.host || e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.interactId !== null || this.selected.size !== 1) return;
      const id = [...this.selected][0];
      if (this.entries.has(id) && this.activate(id, true)) e.preventDefault();
    };
    this.doc.addEventListener('pointerdown', onDown, true);
    this.doc.addEventListener('keydown', onKeyDoc, true);
    this.host.addEventListener('keydown', onKeyHost);
    this.cleanups.push(
      () => this.doc.removeEventListener('pointerdown', onDown, true),
      () => this.doc.removeEventListener('keydown', onKeyDoc, true),
      () => this.host.removeEventListener('keydown', onKeyHost),
      this.store.subscribe((e) => this.onStore(e)),
    );
    for (const el of this.store.elements()) this.track(el);
  }

  // ── Public ─────────────────────────────────────────────────────────────────
  // Ids of the cards that hold a live iframe now.
  get live(): ReadonlySet<ElementId> {
    return new Set(this.frames.keys());
  }

  // The card in interact mode (null: none).
  get interacting(): ElementId | null {
    return this.interactId;
  }

  get maxLive(): number {
    return this.touch ? this.opts.maxLiveTouch : this.opts.maxLive;
  }

  // What is known about a card's embed (null: not an embed card).
  info(id: ElementId): Readonly<ResolvedEmbed> | null {
    return this.entries.get(id)?.info ?? null;
  }

  get resolution(): EmbedResolution {
    return this.opts.resolution;
  }

  setOptions(o: EmbedOptions): void {
    if (o.maxLive !== undefined) this.opts.maxLive = o.maxLive;
    if (o.maxLiveTouch !== undefined) this.opts.maxLiveTouch = o.maxLiveTouch;
    if (o.minLivePx !== undefined) this.opts.minLive = normMinLive(o.minLivePx);
    if (o.resolution !== undefined) {
      this.opts.resolution = o.resolution;
      for (const [id, f] of this.frames) this.place(id, f);
    }
    if (o.arbitrarySameOrigin !== undefined && o.arbitrarySameOrigin !== this.opts.arbitrarySameOrigin) {
      this.opts.arbitrarySameOrigin = o.arbitrarySameOrigin;
      for (const [id, e] of this.entries) {
        if (!e.ready) continue;
        const before = e.spec?.sandbox;
        e.spec = this.specFor(e);
        // A live arbitrary frame is rebuilt with the new sandbox the next time it mounts.
        if (e.spec?.sandbox !== before && this.frames.has(id)) this.destroyFrame(id);
      }
    }
    this.requestPlan();
  }

  // Interact mode on a card: make it live (whatever its size) and give it pointer events. A card the page
  // refuses to frame opens its URL in a new tab instead. Returns false when there is nothing to do.
  interact(id: ElementId): boolean {
    return this.activate(id, false);
  }

  exitInteract(): void {
    const id = this.interactId;
    this.pendingInteract = null;
    if (id === null) return;
    this.interactId = null;
    const f = this.frames.get(id);
    if (f) {
      delete f.wrapper.dataset.interact;
    }
    this.done.style.display = 'none';
    // Keys belong to the board again.
    if (this.doc.activeElement && this.doc.activeElement !== this.host) {
      try {
        this.host.focus({ preventScroll: true });
      } catch {
        // Not focusable.
      }
    }
    this.emit('embedInteract', { id, active: false });
    this.requestPlan();
  }

  // ── Board hooks ────────────────────────────────────────────────────────────
  setSelection(ids: readonly ElementId[]): void {
    this.selected = new Set(ids);
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) e.lastUsed = ++this.clock;
    }
    if (this.interactId !== null && !this.selected.has(this.interactId)) this.exitInteract();
    this.requestPlan();
  }

  setTouch(touch: boolean): void {
    if (touch === this.touch) return;
    this.touch = touch;
    this.requestPlan();
  }

  onDblClick(id: ElementId | null): void {
    if (id !== null && this.entries.has(id)) this.activate(id, false);
  }

  // Generated tiles follow the theme.
  setTheme(): void {
    for (const [id, e] of this.entries) if (e.ownKind === 'tile') void this.makeTile(id, e, e.token);
  }

  onFrame(camChanged: boolean): void {
    if (this.disposed) return;
    if (camChanged) this.moving = true;
    for (const [id, f] of this.frames) this.place(id, f);
    if (!this.moving && this.planDirty) this.runPlan();
  }

  onSettle(): void {
    if (this.disposed) return;
    this.moving = false;
    this.planDirty = true;
    if (this.pendingInteract !== null) {
      const id = this.pendingInteract;
      this.pendingInteract = null;
      if (this.activate(id, false)) return;
    }
    this.runPlan();
  }

  dispose(): void {
    if (this.disposed) return;
    this.exitInteract();
    this.disposed = true;
    for (const id of [...this.frames.keys()]) this.destroyFrame(id);
    for (const e of this.entries.values()) {
      if (e.ownUrl) URL.revokeObjectURL(e.ownUrl);
      for (const u of e.stale) URL.revokeObjectURL(u);
    }
    for (const [t, url] of this.timers) {
      clearTimeout(t);
      URL.revokeObjectURL(url);
    }
    this.timers.clear();
    this.entries.clear();
    for (const f of this.cleanups) f();
    this.root.remove();
  }

  // ── Tracking and resolution ────────────────────────────────────────────────
  private onStore(e: StoreEvent): void {
    if (e.type !== 'change' || this.disposed) return;
    for (const el of e.change.removed) this.untrack(el.id);
    for (const el of e.change.added) this.track(el);
    for (const u of e.change.updated) this.track(u.el);
    this.planDirty = true;
  }

  private untrack(id: ElementId): void {
    if (this.frames.has(id)) this.destroyFrame(id);
    if (this.interactId === id) this.exitInteract();
    const e = this.entries.get(id);
    if (!e) return;
    e.token++;
    if (e.ownUrl) this.retire(e.ownUrl);
    for (const u of e.stale) this.retire(u);
    this.entries.delete(id);
  }

  private track(el: Element): void {
    const embed = el.media.embed;
    if (el.kind !== 'embed' || !embed) {
      this.untrack(el.id);
      return;
    }
    const prev = this.entries.get(el.id);
    if (prev && sameEmbed(prev.embed, embed)) {
      // Fields `sameEmbed` ignores (the per-card `resolution`) still change what the live frame looks like.
      if (prev.embed !== embed) {
        prev.embed = embed;
        const f = this.frames.get(el.id);
        if (f) this.place(el.id, f);
        this.requestPlan();
      }
      // The host replaced `media` wholesale and dropped the poster this layer had written: put it back.
      if (el.media.src === undefined && prev.ownUrl) this.writePoster(el.id, prev.ownUrl);
      return;
    }
    const stale = new Set<string>();
    if (prev) {
      if (this.frames.has(el.id)) this.destroyFrame(el.id);
      if (this.interactId === el.id) this.exitInteract();
      prev.token++;
      if (prev.ownUrl) stale.add(prev.ownUrl);
      for (const u of prev.stale) stale.add(u);
    }
    const info = baseResolved(embed);
    const entry: Entry = {
      embed,
      info,
      ready: false,
      spec: null,
      token: (prev?.token ?? 0) + 1,
      ownUrl: null,
      ownKind: null,
      stale,
      initialAspect: el.w > 0 ? el.h / el.w : 1,
      lastUsed: prev?.lastUsed ?? 0,
    };
    this.entries.set(el.id, entry);
    // No resolver: what the URL says is final, and the card can go live at once.
    if (!this.opts.resolve || info.kind === 'html' || info.url === '') this.settle(entry);
    void this.resolve(el.id, entry);
  }

  private settle(entry: Entry): void {
    entry.ready = true;
    entry.spec = this.specFor(entry);
    if (entry.spec === null && entry.info.kind === 'url') entry.info = { ...entry.info, frameable: false };
    this.requestPlan();
  }

  private specFor(entry: Entry): IframeSpec | null {
    return canGoLive(entry.info)
      ? iframeSpecFor({
          source: entry.embed,
          iframeSrc: entry.info.iframeSrc ?? undefined,
          appOrigin: this.appOrigin,
          arbitrarySameOrigin: this.opts.arbitrarySameOrigin,
        })
      : null;
  }

  private async resolve(id: ElementId, entry: Entry): Promise<void> {
    // Never inside the store's change notification that got us here.
    await Promise.resolve();
    const token = entry.token;
    const alive = (): boolean => !this.disposed && this.entries.get(id) === entry && entry.token === token;
    if (!entry.ready) {
      let answer: Awaited<ReturnType<EmbedResolver>> = null;
      const resolver = this.opts.resolve;
      if (resolver) {
        try {
          answer = await withTimeout(Promise.resolve(resolver(entry.info.url)), this.opts.resolveTimeoutMs);
        } catch (err) {
          console.warn('[corkboard] embed resolver failed:', err);
        }
      }
      if (!alive()) return;
      entry.info = mergeResolved(entry.info, answer);
      this.settle(entry);
    }
    // The shape a resolver reported, for a card that still has the shape it was created with.
    const el = this.store.get(id);
    if (!el || !alive()) return;
    const a = entry.info.aspect;
    const cur = el.w > 0 ? el.h / el.w : 1;
    if (
      a !== undefined &&
      el.media.aspect === undefined &&
      Math.abs(cur - entry.initialAspect) < 0.01 &&
      Math.abs(a - cur) > 0.005
    ) {
      this.store.update(id, { h: Math.max(1, Math.round(el.w * a)) });
    }
    // A picture of the host's stays as it is; otherwise this layer supplies one.
    const hostPoster = this.needsPoster(id) ? undefined : this.store.get(id)?.media.src;
    const photo = hostPoster === undefined ? await this.loadPoster(id, entry, token) : null;
    if (!alive()) return;
    this.emit('embedResolved', {
      id,
      provider: entry.info.provider,
      frameable: entry.info.frameable,
      aspect: entry.info.aspect,
      title: entry.info.title,
      // A URL worth persisting: the host's, or a provider thumbnail. A generated tile is a blob that dies
      // with the page, so it is not reported.
      poster: hostPoster ?? photo ?? undefined,
    });
  }

  // The card has no picture of the host's: this layer supplies one. Any `blob:` src counts as ours: the ones
  // this entry made (current or stale), and those of an earlier session that a saved `board.all()` or an
  // undo stack brought back, whose blob died with that page. (So a host's own `blob:` poster on an embed
  // card is replaced: give it an https or data: URL.)
  private needsPoster(id: ElementId): boolean {
    const src = this.store.get(id)?.media.src;
    return src === undefined || src.startsWith('blob:');
  }

  // Returns the candidate URL that became the poster, null for a generated tile.
  private async loadPoster(id: ElementId, entry: Entry, token: number): Promise<string | null> {
    const alive = (): boolean => !this.disposed && this.entries.get(id) === entry && entry.token === token;
    for (const candidate of entry.info.posters) {
      const url = await fetchPoster(candidate);
      if (!alive()) {
        if (url) URL.revokeObjectURL(url);
        return null;
      }
      if (url) {
        this.applyPoster(id, entry, url, 'photo');
        return candidate;
      }
    }
    await this.makeTile(id, entry, token);
    return null;
  }

  private async makeTile(id: ElementId, entry: Entry, token: number): Promise<void> {
    const el = this.store.get(id);
    if (!el) return;
    const theme: Theme = this.stage.activeTheme;
    const blob = await drawTile(tileSpec(entry.info), el.w > 0 ? el.h / el.w : 0.5625, theme);
    if (!blob) return;
    if (this.disposed || this.entries.get(id) !== entry || entry.token !== token) return;
    this.applyPoster(id, entry, URL.createObjectURL(blob), 'tile');
  }

  private applyPoster(id: ElementId, entry: Entry, url: string, kind: 'photo' | 'tile'): void {
    const prev = entry.ownUrl;
    entry.ownUrl = url;
    entry.ownKind = kind;
    this.writePoster(id, url);
    if (prev) this.retire(prev);
    for (const u of entry.stale) this.retire(u);
    entry.stale.clear();
  }

  private writePoster(id: ElementId, url: string): void {
    const el = this.store.get(id);
    if (el) this.store.update(id, { media: { ...el.media, src: url } });
    else URL.revokeObjectURL(url);
  }

  // The old texture may still be in flight in a decode worker: revoke later.
  private retire(url: string): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      URL.revokeObjectURL(url);
    }, REVOKE_DELAY_MS);
    this.timers.set(t, url);
  }

  // ── Live iframes ───────────────────────────────────────────────────────────
  private requestPlan(): void {
    this.planDirty = true;
    this.stage.markDirty();
  }

  private cards(): PolicyCard[] {
    const cam = this.stage.cam;
    const view = cam.visibleRect();
    const k = cam.scale;
    const out: PolicyCard[] = [];
    for (const [id, entry] of this.entries) {
      const el = this.store.get(id);
      if (!el || !entry.ready) continue;
      const r = this.stage.previewRectOf(id) ?? el;
      const b = elementBox({ x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot });
      // The part of the card that is in view: a neighbour with a sliver showing is not worth an iframe.
      const visW = (Math.min(b.maxX, view.x1) - Math.max(b.minX, view.x0)) * k;
      const visH = (Math.min(b.maxY, view.y1) - Math.max(b.minY, view.y0)) * k;
      out.push({
        id,
        screenW: Math.min(r.w * k, visW),
        screenH: Math.min(r.h * k, visH),
        onScreen: visW >= 0 && visH >= 0,
        selected: this.selected.has(id),
        interacting: this.interactId === id,
        frameable: entry.spec !== null,
        live: this.frames.has(id),
        lastUsed: entry.lastUsed,
      });
    }
    return out;
  }

  private runPlan(force = false): void {
    this.planDirty = false;
    const plan = planLive({
      cards: this.cards(),
      cameraMoving: this.moving && !force,
      scale: this.stage.cam.scale,
      max: this.maxLive,
      minW: this.opts.minLive.w,
      minH: this.opts.minLive.h,
      minScale: MIN_LIVE_SCALE,
    });
    for (const id of plan.destroy) this.destroyFrame(id);
    for (const id of plan.mount) this.mountFrame(id);
  }

  private mountFrame(id: ElementId): void {
    const entry = this.entries.get(id);
    const spec = entry?.spec;
    if (!entry || !spec || this.frames.has(id)) return;
    const wrapper = this.doc.createElement('div');
    wrapper.className = 'cb-embed';
    const iframe = this.doc.createElement('iframe');
    iframe.title = spec.title;
    iframe.setAttribute('sandbox', spec.sandbox);
    iframe.setAttribute('allow', spec.allow);
    iframe.setAttribute('referrerpolicy', spec.referrerPolicy);
    iframe.setAttribute('loading', spec.loading);
    if (spec.srcdoc !== undefined) iframe.srcdoc = spec.srcdoc;
    else if (spec.src !== undefined) iframe.src = spec.src;
    const frame: Frame = { wrapper, iframe, loaded: false, w: NaN, h: NaN, transform: '', z: NaN };
    iframe.addEventListener('load', () => {
      frame.loaded = true;
      wrapper.dataset.ready = '';
    });
    wrapper.appendChild(iframe);
    const el = this.store.get(id);
    if (el) wrapper.style.borderRadius = `${el.radius}px`;
    this.frames.set(id, frame);
    entry.lastUsed = ++this.clock;
    this.place(id, frame);
    this.root.insertBefore(wrapper, this.done);
    this.emit('embedLive', { id, live: true });
  }

  private destroyFrame(id: ElementId): void {
    const f = this.frames.get(id);
    if (!f) return;
    this.frames.delete(id);
    if (this.interactId === id) this.exitInteract();
    // Navigate away first so the page (and its process) is released, then drop the node.
    f.iframe.removeAttribute('srcdoc');
    f.iframe.src = 'about:blank';
    f.wrapper.remove();
    this.emit('embedLive', { id, live: false });
  }

  // Writes size and transform only when they changed.
  private place(id: ElementId, f: Frame): void {
    const r = this.stage.previewRectOf(id) ?? this.store.get(id);
    if (!r) return;
    const cam: Camera = this.stage.cam.cam;
    const res = this.entries.get(id)?.embed.resolution ?? this.opts.resolution;
    const p = embedPlacement({ x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot }, cam, res);
    const s = f.wrapper.style;
    if (p.width !== f.w) {
      f.w = p.width;
      s.width = `${p.width}px`;
    }
    if (p.height !== f.h) {
      f.h = p.height;
      s.height = `${p.height}px`;
    }
    if (p.transform !== f.transform) {
      f.transform = p.transform;
      s.transform = p.transform;
    }
    const z = this.store.rank(id) + 1;
    if (z !== f.z) {
      f.z = z;
      s.zIndex = String(z);
    }
    if (this.interactId === id) {
      const w = this.stage.cam.width;
      const h = this.stage.cam.height;
      const x = Math.min(Math.max(p.topRightX, 90), w) - DONE_MARGIN;
      const y = Math.min(Math.max(p.topRightY, 0), h - 40) + DONE_MARGIN;
      this.done.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translateX(-100%)`;
    }
  }

  // ── Interact mode ──────────────────────────────────────────────────────────
  private activate(id: ElementId, keyboard: boolean): boolean {
    const entry = this.entries.get(id);
    const el = this.store.get(id);
    if (!entry || !el || !entry.ready) return false;
    if (this.interactId === id) return true;
    if (entry.spec === null) {
      // A bookmark: the page cannot be framed.
      if (entry.info.url !== '') window.open(entry.info.url, '_blank', 'noopener,noreferrer');
      return true;
    }
    if (this.stage.cam.scale < MIN_LIVE_SCALE) {
      // Too far out to mount anything: fly in, then interact once the camera settles.
      this.pendingInteract = id;
      this.stage.fitRect(this.stage.contentBounds([id]), true, 48);
      return true;
    }
    if (this.interactId !== null) this.exitInteract();
    entry.lastUsed = ++this.clock;
    this.interactId = id;
    this.runPlan(true);
    const f = this.frames.get(id);
    if (!f) {
      this.interactId = null;
      return false;
    }
    f.wrapper.dataset.interact = '';
    this.done.style.display = 'block';
    this.place(id, f);
    if (keyboard) this.done.focus({ preventScroll: true });
    this.emit('embedInteract', { id, active: true });
    return true;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
