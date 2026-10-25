// The interaction layer: pointer, wheel, touch and keyboard on the board's host element.
//
//   wheel / pinch      pan and zoom (ctrl or cmd + wheel zooms about the cursor)
//   drag on empty      pans (with inertia); with Shift it draws a marquee instead (`emptyDrag: 'marquee'`
//                      flips the two)
//   click / shift      select / toggle a card; click on empty clears
//   drag a card        moves the selection, snapping to guides and the grid; Shift locks the axis
//   drag a handle      resizes (aspect-locked cards keep their ratio; Alt resizes about the centre)
//   keys               Delete removes, Esc clears, Cmd/Ctrl+A selects all, arrows nudge, 0 fits, 1 = 100 %
//
// During a gesture the cards are drawn at a preview rect by the stage (nothing is written to the store, and a
// dragged card is only drawn on top: `store.lift`); the store is updated once on release, the move and the
// bring-to-front in one batch, so a gesture is one `change` event. No undo, no history.
import { assertGeometry } from '../check';
import { Emitter } from '../events';
import type { SelectionVisual } from '../render/overlay';
import type { Stage } from '../render/stage';
import { GRID } from '../render/stage';
import type { Store } from '../store';
import type { Box } from '../math';
import type { Card, CardId } from '../types';
import type { Aabb, WorldRect } from './geometry';
import { boxUnion, worldRectOf } from './geometry';
import type { Guide } from './snapping';
import { geometryBox, handleAt, selectionHandles, type HandleId, type SelectionHandles } from './handles';
import { hitTest } from './hitTest';
import { elementsInBox } from './marquee';
import { outlineOf, type OutlineRect } from './outline';
import { ResizeSession, type Mods } from './resize';
import { SnapSession, type SnapSettings } from './snap';

/**
 * Options of the pointer, touch and keyboard layer (`CorkboardOptions.interaction`). Wheel and pinch always pan
 * and zoom.
 */
export interface InteractionOptions {
  /** Selecting, moving and resizing cards (default true). With false the layer only pans and zooms. */
  select?: boolean;
  /** What dragging the empty canvas does (default 'pan'); Shift does the other one. */
  emptyDrag?: 'pan' | 'marquee';
  /**
   * Keyboard shortcuts on the focused board.
   * @default true
   */
  keyboard?: boolean;
  /**
   * Dragging, resizing, nudging and Delete write to the store (on release, on each key press) - one `change`
   * event per gesture, `source: 'user'` (default true). With false the layer NEVER writes: it emits `transform`
   * (the proposed rects and, for a drag, the cards to bring to the front) and `delete` (the ids) as proposals and
   * leaves the cards where they are, for a host that owns the state and applies them itself (controlled mode).
   * A card being dragged is still drawn on top until the release.
   */
  commit?: boolean;
  /** Rubber-band selection (default true). With false a drag on the empty canvas always pans, Shift or not. */
  marquee?: boolean;
  /**
   * A drag on the empty canvas pans without clearing the selection first; a click that does not move still
   * clears it (default false: the selection is cleared as soon as the pointer goes down on empty canvas).
   */
  keepSelectionOnPan?: boolean;
  /**
   * Draw the selection outline and the resize handles on the canvas (default true). With false the layer
   * still selects, moves and resizes (the handles keep their hit areas) but draws no selection: the host
   * draws its own. The hover outline is not part of it.
   */
  selectionOutline?: boolean;
}

/** The events of the interaction layer; the board re-emits them (see `CorkboardEvents`). Points are in world coordinates. */
export interface InteractionEvents {
  /** The selection changed: the selected ids now. */
  selection: { ids: readonly CardId[] };
  /** The card under the pointer changed (`null`: none). Touch has no hover. */
  hover: { id: CardId | null };
  /** A click (or tap): the card hit (`null`: the empty canvas), whether Shift was held, and the point in world coordinates. */
  click: { id: CardId | null; shift: boolean; x: number; y: number };
  /** A double click (or double tap): the card hit (`null`: the empty canvas) and the point in world coordinates. */
  dblclick: { id: CardId | null; x: number; y: number };
  /**
   * A drag, resize or arrow-key nudge ended: the new {@link Box} of every card it touched, in world px (already
   * written to the store, in one `change` event, unless `commit` is false: then it is a proposal).
   */
  transform: {
    kind: 'move' | 'resize';
    rects: ReadonlyMap<CardId, Box>;
    /**
     * Set by a pointer drag: the cards it holds, bottom of the draw order first, which a drag brings to the front.
     * Already done when `commit` is on (it is part of the same `change`); with `commit: false` it is the proposal:
     * `board.bringToFront(toFront)`.
     */
    toFront?: readonly CardId[];
  };
  /** A gesture started or ended: its kind, or `null` when it ended. */
  gesture: { kind: 'pan' | 'marquee' | 'drag' | 'resize' | 'pinch' | null };
  /** The pointer device changed between touch and mouse / pen (`touch: true`: touch). */
  touch: { touch: boolean };
  /**
   * Delete was pressed with a selection: the ids (locked cards excluded). With `commit` on they were removed
   * just before this fires; with `commit: false` nothing was, it is a proposal.
   */
  delete: { ids: readonly CardId[] };
}

const DRAG_THRESHOLD_PX = 3;
const NUDGE = 1;
const NUDGE_BIG = 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;

type Gesture =
  // `noClick`: the pan began as a drag of a locked card, so letting go is not a click on the canvas.
  | { kind: 'pan'; x: number; y: number; clearOnClick?: boolean; noClick?: boolean }
  | { kind: 'pinch'; dist: number; mx: number; my: number }
  | {
      kind: 'marquee';
      // Where it began: in world space (the box) and in screen space (is it a click).
      sx: number;
      sy: number;
      x: number;
      y: number;
      base: readonly CardId[];
      additive: boolean;
    }
  | {
      kind: 'press';
      id: CardId;
      x: number;
      y: number;
      shift: boolean;
      wasSelected: boolean;
    }
  | {
      kind: 'drag';
      ids: readonly CardId[];
      start: { x: number; y: number };
      rects: Map<CardId, WorldRect>;
      box: Aabb;
      snap: SnapSession;
      moved: boolean;
    }
  | { kind: 'resize'; session: ResizeSession; snap: SnapSession; handle: HandleId };

/** The pointer, touch and keyboard layer of a board. The board owns one; reach it with `getInternals`. */
export class Interaction {
  readonly events = new Emitter<InteractionEvents>();
  selection: readonly CardId[] = [];
  readonly snapping: SnapSettings;

  private readonly opts: Required<InteractionOptions>;
  // Options set while a gesture runs, applied at the next pointer down.
  private pendingOpts: Partial<InteractionOptions> | null = null;
  private gesture: Gesture | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pointerType = 'mouse';
  private hoverId: CardId | null = null;
  private selDirty = true;
  private spaceDown = false;
  // A host-driven hand tool (`setPanMode`): like holding Space.
  private panMode = false;
  private handles: SelectionHandles | null = null;
  // The zoom the handles were built at: an edge too short on screen has no handle, so they follow the zoom.
  private handlesScale = 1;
  // Whether the stage had previews at the last frame.
  private hadPreviews = false;
  private lastMods: Mods = { shift: false, alt: false, ctrl: false };
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly stage: Stage,
    private readonly store: Store,
    snapping: SnapSettings,
    options: InteractionOptions = {},
  ) {
    this.snapping = snapping;
    this.opts = {
      select: options.select ?? true,
      emptyDrag: options.emptyDrag ?? 'pan',
      keyboard: options.keyboard ?? true,
      commit: options.commit ?? true,
      marquee: options.marquee ?? true,
      keepSelectionOnPan: options.keepSelectionOnPan ?? false,
      selectionOutline: options.selectionOutline ?? true,
    };
    this.bind();
    this.cleanups.push(
      this.store.subscribe((e) => {
        if (e.type !== 'change') return;
        const gone = e.change.removed;
        if (gone.length > 0) this.dropRemoved(new Set(gone.map((g) => g.id)));
        // `loadSnapshot` replaced the board: what a gesture held (even a card that kept its id) is not what it
        // started from, and releasing would write its position over the loaded one.
        if (e.change.reload) this.cancelGesture();
        this.selDirty = true;
        this.stage.requestFrame();
      }),
      this.stage.onFrame(() => this.onFrame()),
    );
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  setSelection(ids: readonly CardId[]): void {
    const next = ids.filter((id, i) => this.store.has(id) && ids.indexOf(id) === i);
    const same =
      next.length === this.selection.length && next.every((id, i) => id === this.selection[i]);
    if (same) return;
    this.selection = next;
    this.selDirty = true;
    this.events.emit('selection', { ids: next });
    this.stage.requestFrame();
  }

  // Changes the options. A running gesture reads them again on release (`commit`, say), so while one is going
  // (or a pointer is down) the change waits for the next pointer down.
  setOptions(o: Partial<InteractionOptions>): void {
    const next = { ...this.pendingOpts };
    for (const k of Object.keys(o) as (keyof InteractionOptions)[]) {
      if (o[k] !== undefined) (next as Record<string, unknown>)[k] = o[k];
    }
    this.pendingOpts = next;
    if (this.gesture === null && this.pointers.size === 0) this.applyOptions();
  }

  private applyOptions(): void {
    if (!this.pendingOpts) return;
    Object.assign(this.opts, this.pendingOpts);
    this.pendingOpts = null;
    this.selDirty = true;
    this.stage.requestFrame();
  }

  // A hand tool the host can switch (a toolbar button, a key of its own): while on, a left-button drag
  // pans the canvas wherever it starts, over a card included, exactly as with Space held.
  setPanMode(on: boolean): void {
    this.panMode = on;
    if (on) this.setHover(null);
  }

  // Cards left the store: out of the selection, the hover and the gesture that holds them.
  private dropRemoved(dead: ReadonlySet<CardId>): void {
    if (this.selection.length > 0) {
      const next = this.selection.filter((id) => !dead.has(id));
      if (next.length !== this.selection.length) this.setSelection(next);
    }
    if (this.hoverId !== null && dead.has(this.hoverId)) this.setHover(null);
    const g = this.gesture;
    if (g?.kind === 'press') {
      if (dead.has(g.id)) this.cancelGesture();
    } else if (g?.kind === 'drag') {
      const left = g.ids.filter((id) => !dead.has(id));
      if (left.length === g.ids.length) return;
      for (const id of g.ids) {
        if (!dead.has(id)) continue;
        g.rects.delete(id);
        this.stage.clearPreview(id);
        this.stage.pin(id, false);
      }
      if (left.length === 0) {
        this.cancelGesture();
        return;
      }
      g.ids = left;
      let box: Aabb | null = null;
      for (const r of g.rects.values()) {
        const b = geometryBox([r]) as Aabb;
        box = box ? boxUnion(box, b) : b;
      }
      g.box = box as Aabb;
    } else if (g?.kind === 'resize') {
      const lost = g.session.affected.filter((id) => dead.has(id));
      if (lost.length === 0) return;
      for (const id of lost) {
        this.stage.clearPreview(id);
        this.stage.pin(id, false);
      }
      // The rest keeps scaling about the box it started in.
      if (lost.length === g.session.affected.length) this.cancelGesture();
    }
  }

  // ── Frame ──────────────────────────────────────────────────────────────────
  private onFrame(): void {
    const g = this.gesture;
    const live = g !== null && (g.kind === 'drag' || g.kind === 'resize');
    if (this.stage.cam.scale !== this.handlesScale) this.selDirty = true;
    // Cards drawn at a preview that is not ours (a layout animation) move under the selection: it follows
    // them, handles hidden, and is drawn once more at the store's rects when the previews are gone.
    const previewed = this.stage.previewCount > 0;
    if (previewed || this.hadPreviews) this.selDirty = true;
    this.hadPreviews = previewed;
    if (!this.selDirty && !live) return;
    this.selDirty = false;
    const visual = this.selectionVisual(!live && !previewed);
    this.stage.overlay.setSelection(this.opts.selectionOutline ? visual : null);
    if (live) this.stage.requestFrame();
  }

  private selectionVisual(showHandles: boolean): SelectionVisual | null {
    this.handlesScale = this.stage.cam.scale;
    const els: Card[] = [];
    for (const id of this.selection) {
      const el = this.store.get(id);
      if (el) els.push(el);
    }
    this.handles = null;
    if (els.length === 0) return null;
    const rects = els.map((el) => this.stage.previewRectOf(el.id) ?? worldRectOf(el));
    if (els.length === 1) {
      this.handles = selectionHandles(this.store, this.selection, this.stage.cam.scale);
      return {
        frame: outlineOf(els[0], rects[0]),
        members: [],
        handles: this.handles?.handles ?? [],
        showHandles: showHandles && this.handles !== null,
      };
    }
    const b = geometryBox(rects) as Aabb;
    this.handles = selectionHandles(this.store, this.selection, this.stage.cam.scale);
    return {
      frame: { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY, rot: 0, radius: 0 },
      members: els.map((el, i) => outlineOf(el, rects[i])),
      handles: this.handles?.handles ?? [],
      showHandles: showHandles && this.handles !== null,
    };
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  private bind(): void {
    const host = this.host;
    host.tabIndex = 0;
    host.style.outline = 'none';
    host.style.touchAction = 'none';
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      host.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => host.removeEventListener(type, fn as EventListener, opts));
    };
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e));
    on('pointercancel', (e) => this.onUp(e, true));
    // The capture went away under a held button (the element was hidden, the browser took the pointer
    // back): no pointerup is coming.
    on('lostpointercapture', (e) => {
      if (this.pointers.has(e.pointerId)) this.onUp(e, true);
    });
    on('pointerleave', () => this.setHover(null));
    on('dblclick', (e) => this.onDblClick(e));
    on('keydown', (e) => this.onKey(e));
    on('contextmenu', (e) => {
      if (this.gesture) e.preventDefault();
    });
    // Space is let go wherever focus is by then (a key released in another window, or after focus moved
    // off the board, never reaches the host): listen on the window, and drop it when the window blurs.
    const releaseSpace = (e: KeyboardEvent): void => {
      if (e.code === 'Space') this.spaceDown = false;
    };
    // A window that loses focus mid-gesture never hears the pointerup either: the gesture is dropped.
    const onBlur = (): void => {
      this.spaceDown = false;
      this.cancelGesture();
      this.pointers.clear();
    };
    window.addEventListener('keyup', releaseSpace);
    window.addEventListener('blur', onBlur);
    this.cleanups.push(() => {
      window.removeEventListener('keyup', releaseSpace);
      window.removeEventListener('blur', onBlur);
    });
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    return this.stage.clientToLocal(e.clientX, e.clientY);
  }

  private mods(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods {
    this.lastMods = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
    return this.lastMods;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    this.stage.cam.wheel({
      x: p.x,
      y: p.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      zoom: e.ctrlKey || e.metaKey,
    });
    this.setHover(null);
  }

  private startGesture(g: Gesture): void {
    this.gesture = g;
    if (g.kind === 'press') return;
    this.events.emit('gesture', { kind: g.kind });
  }

  private endGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    this.stage.overlay.setGuides([]);
    this.stage.overlay.setMarquee(null);
    this.host.style.cursor = '';
    this.selDirty = true;
    this.stage.requestFrame();
    if (g && g.kind !== 'press') this.events.emit('gesture', { kind: null });
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    this.host.focus({ preventScroll: true });
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events carry no active pointer.
    }
    const touch = e.pointerType === 'touch';
    if (touch !== (this.pointerType === 'touch')) this.events.emit('touch', { touch });
    this.pointerType = e.pointerType;
    const p = this.local(e);
    // This pointer is already down: the release of its last press never came. That gesture is over.
    if (this.gesture && this.pointers.has(e.pointerId)) this.cancelGesture();
    // A change of options asked for during a gesture lands here, before the next one begins.
    if (this.gesture === null && this.pointers.size === 0) this.applyOptions();
    this.pointers.set(e.pointerId, p);
    this.mods(e);
    this.setHover(null);

    if (this.pointers.size === 2) {
      this.cancelGesture();
      this.stage.cam.dragEnd(-1e9);
      const [a, b] = [...this.pointers.values()];
      this.startGesture({
        kind: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      });
      return;
    }
    if (this.pointers.size > 2) return;

    const stage = this.stage;
    const w = stage.screenToWorld(p.x, p.y);
    if (e.button === 1 || this.spaceDown || this.panMode || !this.opts.select) {
      this.beginPan(p, e);
      return;
    }
    // A handle of the current selection? Built now: the zoom may have moved since the last frame.
    const sel =
      this.selection.length > 0 ? selectionHandles(this.store, this.selection, stage.cam.scale) : null;
    if (sel) {
      const h = handleAt(sel, w.x, w.y, stage.cam.scale);
      if (h) {
        const session = new ResizeSession(this.store, this.selection, h.id, w);
        if (session.affected.length > 0) {
          const snap = new SnapSession(this.snapping, GRID);
          snap.begin(this.store, stage.cam.visibleRect(), stage.cam.scale, new Set(session.affected));
          this.startGesture({ kind: 'resize', session, snap, handle: h.id });
          for (const id of session.affected) stage.pin(id, true);
          this.selDirty = true;
          return;
        }
      }
    }
    const hit = hitTest(this.store, w.x, w.y, { zoom: stage.cam.scale });
    if (hit) {
      const wasSelected = this.selection.includes(hit.id);
      if (e.shiftKey) {
        // Shift on a selected card takes it out of the selection when let go without a drag (see onUp): a
        // drag moves the whole selection, this card included.
        if (!wasSelected) this.setSelection([...this.selection, hit.id]);
      } else if (!wasSelected) {
        this.setSelection([hit.id]);
      }
      this.startGesture({ kind: 'press', id: hit.id, x: p.x, y: p.y, shift: e.shiftKey, wasSelected });
      return;
    }
    // Empty canvas.
    const marquee = this.opts.marquee && (this.opts.emptyDrag === 'marquee') !== e.shiftKey;
    if (marquee) {
      this.startGesture({
        kind: 'marquee',
        sx: w.x,
        sy: w.y,
        x: p.x,
        y: p.y,
        base: e.shiftKey ? this.selection : [],
        additive: e.shiftKey,
      });
      if (!e.shiftKey) this.setSelection([]);
    } else {
      const keep = this.opts.keepSelectionOnPan;
      if (!e.shiftKey && !keep) this.setSelection([]);
      this.beginPan(p, e, keep && !e.shiftKey);
    }
  }

  private beginPan(
    p: { x: number; y: number },
    e: PointerEvent,
    clearOnClick = false,
    noClick = false,
  ): void {
    this.startGesture({ kind: 'pan', x: p.x, y: p.y, clearOnClick, noClick });
    this.stage.cam.dragStart(p.x, p.y, e.timeStamp);
    this.host.style.cursor = 'grabbing';
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    const m = this.mods(e);
    if (!this.pointers.has(e.pointerId)) {
      if (e.buttons === 0 && e.pointerType !== 'touch') this.updateHover(p);
      return;
    }
    const g = this.gesture;
    // A mouse that moves with no button down let go where we could not hear it (outside the window): the
    // gesture is over, dropped like a pointercancel.
    if (g && e.pointerType === 'mouse' && e.buttons === 0) {
      this.onUp(e, true);
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (!g) return;
    const stage = this.stage;
    switch (g.kind) {
      case 'pan':
        stage.cam.dragMove(p.x, p.y, e.timeStamp);
        break;
      case 'pinch': {
        if (this.pointers.size < 2) break;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        stage.cam.pinch(mx, my, dist / Math.max(1, g.dist), mx - g.mx, my - g.my);
        g.dist = dist;
        g.mx = mx;
        g.my = my;
        break;
      }
      case 'marquee': {
        const w = stage.screenToWorld(p.x, p.y);
        const box: Aabb = {
          minX: Math.min(g.sx, w.x),
          minY: Math.min(g.sy, w.y),
          maxX: Math.max(g.sx, w.x),
          maxY: Math.max(g.sy, w.y),
        };
        stage.overlay.setMarquee(box);
        const inside = elementsInBox(this.store, box, 'touch');
        this.setSelection(g.additive ? [...new Set([...g.base, ...inside])] : inside);
        break;
      }
      case 'press': {
        if (Math.hypot(p.x - g.x, p.y - g.y) < DRAG_THRESHOLD_PX) break;
        this.beginDrag(g, p);
        break;
      }
      case 'drag':
        this.updateDrag(g, p, m);
        break;
      case 'resize':
        this.updateResize(g, p, m);
        break;
    }
  }

  private beginDrag(press: Extract<Gesture, { kind: 'press' }>, p: { x: number; y: number }): void {
    const stage = this.stage;
    const ids = this.selection.filter((id) => {
      const el = this.store.get(id);
      return el !== undefined && !el.locked;
    });
    if (ids.length === 0) {
      // Locked card: dragging it pans the canvas instead (and is not a click on the canvas).
      this.gesture = null;
      this.beginPan(p, { timeStamp: performance.now() } as PointerEvent, false, true);
      return;
    }
    const rects = new Map<CardId, WorldRect>();
    let box: Aabb | null = null;
    for (const id of ids) {
      const el = this.store.get(id) as Card;
      const r = worldRectOf(el);
      rects.set(id, r);
      stage.pin(id, true);
      const b = geometryBox([r]) as Aabb;
      box = box ? boxUnion(box, b) : b;
    }
    const snap = new SnapSession(this.snapping, GRID);
    snap.begin(this.store, stage.cam.visibleRect(), stage.cam.scale, new Set(ids));
    const start = stage.screenToWorld(press.x, press.y);
    this.startGesture({ kind: 'drag', ids, start, rects, box: box as Aabb, snap, moved: false });
    this.host.style.cursor = 'grabbing';
    // On top while it is held, with no write: the order is committed with the move on release.
    this.store.lift(ids);
    stage.requestFrame();
    this.updateDrag(this.gesture as Extract<Gesture, { kind: 'drag' }>, p, this.lastMods);
  }

  private updateDrag(g: Extract<Gesture, { kind: 'drag' }>, p: { x: number; y: number }, m: Mods): void {
    const stage = this.stage;
    const w = stage.screenToWorld(p.x, p.y);
    let dx = w.x - g.start.x;
    let dy = w.y - g.start.y;
    // Shift locks the move to the dominant axis.
    if (m.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    g.moved = true;
    const moved: Aabb = {
      minX: g.box.minX + dx,
      minY: g.box.minY + dy,
      maxX: g.box.maxX + dx,
      maxY: g.box.maxY + dy,
    };
    if (m.ctrl) {
      stage.overlay.setGuides([]);
    } else {
      const s = g.snap.move(moved);
      if (!(m.shift && dx === 0)) dx += s.dx;
      if (!(m.shift && dy === 0)) dy += s.dy;
      stage.overlay.setGuides(s.guides as Guide[]);
    }
    for (const [id, r] of g.rects) stage.setPreview(id, r.x + dx, r.y + dy, r.w, r.h, r.rot);
    this.selDirty = true;
  }

  private updateResize(g: Extract<Gesture, { kind: 'resize' }>, p: { x: number; y: number }, m: Mods): void {
    const stage = this.stage;
    const w = stage.screenToWorld(p.x, p.y);
    let guides: readonly Guide[] = [];
    const patches = g.session.update(w, m, (box, edges) => {
      const s = g.snap.resize(box, edges);
      guides = s.guides;
      return s;
    });
    stage.overlay.setGuides(m.ctrl ? [] : (guides as Guide[]));
    for (const [id, patch] of patches) {
      const el = this.store.get(id);
      if (el) stage.setPreview(id, patch.x, patch.y, patch.w, patch.h, el.rot);
    }
    this.selDirty = true;
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    try {
      this.host.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    const g = this.gesture;
    if (!g) return;
    const stage = this.stage;
    switch (g.kind) {
      case 'pan':
        stage.cam.dragEnd(cancelled ? -1e9 : e.timeStamp);
        if (!cancelled && !g.noClick && Math.hypot(p.x - g.x, p.y - g.y) < DRAG_THRESHOLD_PX) {
          if (g.clearOnClick) this.setSelection([]);
          this.emitClick(null, e, p);
        }
        break;
      case 'pinch':
        if (this.pointers.size < 2) {
          this.gesture = null;
          this.events.emit('gesture', { kind: null });
          return;
        }
        return;
      case 'marquee':
        if (!cancelled && Math.hypot(p.x - g.x, p.y - g.y) < DRAG_THRESHOLD_PX) this.emitClick(null, e, p);
        break;
      case 'press':
        if (!cancelled) {
          if (g.shift) {
            if (g.wasSelected) this.setSelection(this.selection.filter((i) => i !== g.id));
          } else if (g.wasSelected && this.selection.length > 1) this.setSelection([g.id]);
          this.emitClick(g.id, e, p);
        }
        break;
      case 'drag':
        if (cancelled) this.cancelDrag(g);
        else this.commitDrag(g);
        break;
      case 'resize':
        if (cancelled) this.cancelResize(g);
        else this.commitResize(g);
        break;
    }
    this.endGesture();
  }

  private emitClick(id: CardId | null, e: PointerEvent, p: { x: number; y: number }): void {
    const w = this.stage.screenToWorld(p.x, p.y);
    this.events.emit('click', { id, shift: e.shiftKey, x: w.x, y: w.y });
  }

  private onDblClick(e: MouseEvent): void {
    const w = this.stage.screenToWorld(this.local(e).x, this.local(e).y);
    const hit = hitTest(this.store, w.x, w.y, { zoom: this.stage.cam.scale });
    this.events.emit('dblclick', { id: hit?.id ?? null, x: w.x, y: w.y });
  }

  // Drops the previews of a cancelled gesture.
  private cancelGesture(): void {
    const g = this.gesture;
    if (g?.kind === 'drag') this.cancelDrag(g);
    else if (g?.kind === 'resize') this.cancelResize(g);
    else if (g?.kind === 'pan') this.stage.cam.dragEnd(-1e9);
    if (g) this.endGesture();
  }

  private cancelDrag(g: Extract<Gesture, { kind: 'drag' }>): void {
    this.store.lift([]);
    for (const id of g.ids) {
      this.stage.clearPreview(id);
      this.stage.pin(id, false);
    }
  }

  private cancelResize(g: Extract<Gesture, { kind: 'resize' }>): void {
    for (const id of g.session.affected) {
      this.stage.clearPreview(id);
      this.stage.pin(id, false);
    }
  }

  // `ids`: every card the gesture held (previewed and pinned), whether or not it ends up in `rects`.
  // `toFront`: the cards a drag brings to the front, written with the move in the same batch.
  private commit(
    kind: 'move' | 'resize',
    ids: readonly CardId[],
    rects: Map<CardId, { x: number; y: number; w: number; h: number }>,
    toFront?: readonly CardId[],
  ): void {
    const stage = this.stage;
    // The lift ends here: with `commit`, the real order takes over in the same synchronous step.
    this.store.lift([]);
    let failure: unknown;
    if (this.opts.commit) {
      try {
        // All or nothing: every rect is checked before the first one is written.
        for (const [id, r] of rects) assertGeometry(`${kind}: card "${id}"`, r);
        this.store.batch(() => {
          for (const [id, r] of rects) {
            this.store.update(id, { x: r.x, y: r.y, w: r.w, h: r.h }, 'user');
          }
          if (toFront) this.store.bringToFront(toFront, 'user');
        }, 'user');
      } catch (err) {
        failure = err;
      }
    }
    // The gesture ends whatever happened: no preview or pin is left behind.
    for (const id of ids) {
      stage.clearPreview(id);
      stage.pin(id, false);
    }
    if (failure !== undefined) throw failure;
    if (rects.size > 0) {
      this.events.emit('transform', toFront ? { kind, rects, toFront } : { kind, rects });
    }
  }

  private commitDrag(g: Extract<Gesture, { kind: 'drag' }>): void {
    if (!g.moved) {
      this.cancelDrag(g);
      return;
    }
    const out = new Map<CardId, { x: number; y: number; w: number; h: number }>();
    for (const id of g.ids) {
      const p = this.stage.previewRectOf(id);
      if (p && this.store.has(id)) out.set(id, { x: round2(p.x), y: round2(p.y), w: p.w, h: p.h });
    }
    // Draw order, bottom first, of the cards that are still there.
    const toFront = [...out.keys()].sort((a, b) => this.store.rank(a) - this.store.rank(b));
    this.commit('move', g.ids, out, toFront);
  }

  private commitResize(g: Extract<Gesture, { kind: 'resize' }>): void {
    const out = new Map<CardId, { x: number; y: number; w: number; h: number }>();
    for (const id of g.session.affected) {
      const p = this.stage.previewRectOf(id);
      if (p && this.store.has(id)) {
        out.set(id, { x: round2(p.x), y: round2(p.y), w: round2(p.w), h: round2(p.h) });
      }
    }
    this.commit('resize', g.session.affected, out);
  }

  // ── Hover and cursor ───────────────────────────────────────────────────────
  private updateHover(p: { x: number; y: number }): void {
    if (this.gesture || !this.opts.select || this.panMode) return;
    const stage = this.stage;
    const w = stage.screenToWorld(p.x, p.y);
    const h = this.handles ? handleAt(this.handles, w.x, w.y, stage.cam.scale) : null;
    if (h) {
      this.host.style.cursor = h.cursor;
      this.setHover(null);
      return;
    }
    this.host.style.cursor = '';
    const hit = hitTest(this.store, w.x, w.y, { zoom: stage.cam.scale });
    this.setHover(hit ? hit.id : null);
  }

  private setHover(id: CardId | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    const el = id ? this.store.get(id) : undefined;
    const showOutline = el !== undefined && !this.selection.includes(el.id);
    const r: OutlineRect | null = showOutline
      ? outlineOf(el as Card, worldRectOf(el as Card))
      : null;
    this.stage.overlay.setHover(r);
    this.events.emit('hover', { id });
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  private onKey(e: KeyboardEvent): void {
    // Keydown bubbles from everything inside the host (an overlay's <input>, a toolbar button): only keys
    // pressed on the board itself are the board's.
    if (e.target !== this.host) return;
    if (e.code === 'Space') {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }
    if (!this.opts.keyboard) return;
    const stage = this.stage;
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.key.toLowerCase() === 'a' && this.opts.select) {
      this.setSelection([...this.store.ids()]);
    } else if (e.key === 'Escape') {
      this.setSelection([]);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.length > 0) {
      const ids = this.selection.filter((id) => !this.store.get(id)?.locked);
      if (ids.length === 0) return;
      // With `commit: false` the host removes the cards itself: it only gets the proposal.
      if (this.opts.commit) this.store.remove(ids, 'user');
      this.events.emit('delete', { ids });
    } else if (e.key.startsWith('Arrow') && this.selection.length > 0 && !cmd) {
      const step = e.shiftKey ? NUDGE_BIG : NUDGE;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const rects = new Map<CardId, { x: number; y: number; w: number; h: number }>();
      // With `commit: false` the host moves the cards itself: it only gets the proposal.
      this.store.batch(() => {
        for (const id of this.selection) {
          const el = this.store.get(id);
          if (!el || el.locked) continue;
          if (this.opts.commit) this.store.update(id, { x: el.x + dx, y: el.y + dy }, 'user');
          rects.set(id, { x: el.x + dx, y: el.y + dy, w: el.w, h: el.h });
        }
      });
      if (rects.size > 0) this.events.emit('transform', { kind: 'move', rects });
    } else if (cmd) {
      return;
    } else if (e.key === '0') {
      if (this.selection.length > 0) stage.fitRect(stage.boundsOf(this.selection));
      else if (this.store.size > 0) stage.fit();
    } else if (e.key === '1') {
      stage.zoomToActual();
    } else if (e.key === '+' || e.key === '=') {
      stage.zoomBy(1.25);
    } else if (e.key === '-') {
      stage.zoomBy(0.8);
    } else return;
    e.preventDefault();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // A gesture in progress let go of: the lift, the previews and the pins would outlive this layer.
    this.cancelGesture();
    for (const f of this.cleanups) f();
    this.events.clear();
  }
}
