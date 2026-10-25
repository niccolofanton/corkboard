// Gestures of the interaction layer against a real Store and a stub stage that keeps the previews and
// pins it is asked for: a card removed under a gesture, a gesture whose release never arrives, the
// selection rules of Shift, and the events a host sees. Pointer events are dispatched on the host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The controller only needs GRID from the stage module; loading Pixi in jsdom is noise.
vi.mock('../../src/render/stage', () => ({ GRID: 24 }));
import { Interaction, type InteractionEvents, type InteractionOptions } from '../../src/interact/controller';
import { createElement } from '../../src/model';
import type { Stage } from '../../src/render/stage';
import { Store } from '../../src/store';
import type { Card, CardInit } from '../../src/types';

let host: HTMLElement;
// jsdom reports an exception thrown by a listener on the window instead of to the dispatcher: collect them.
let errors: unknown[];
const onError = (e: ErrorEvent): void => {
  errors.push(e.error);
  e.preventDefault();
};
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  host = document.getElementById('host') as HTMLElement;
  errors = [];
  window.addEventListener('error', onError);
});
afterEach(() => {
  window.removeEventListener('error', onError);
  expect(errors).toEqual([]);
});

type Init = Partial<CardInit> & { id: string };
const CARD_A: Init = { id: 'a', x: 0, y: 0, w: 100, h: 100 };
const CARD_B: Init = { id: 'b', x: 200, y: 0, w: 100, h: 100 };

function make(options: InteractionOptions = {}, cards: Init[] = [CARD_A]) {
  const store = new Store();
  const previews = new Map<string, { x: number; y: number; w: number; h: number; rot: number }>();
  const pins = new Set<string>();
  const cam = {
    scale: 1,
    dragStart: vi.fn(),
    dragMove: vi.fn(),
    dragEnd: vi.fn(),
    visibleRect: () => ({ x0: -1000, y0: -1000, x1: 1000, y1: 1000 }),
  };
  let frame: () => void = () => {};
  const fit = vi.fn();
  const overlay = { setSelection: vi.fn(), setHover: vi.fn(), setGuides: vi.fn(), setMarquee: vi.fn() };
  const stage = {
    onFrame: (fn: () => void) => {
      frame = fn;
      return () => {};
    },
    requestFrame: () => {},
    overlay,
    cam,
    screenToWorld: (x: number, y: number) => ({ x, y }),
    clientToLocal: (x: number, y: number) => ({ x, y }),
    // What the real stage keeps for the interaction layer; it forgets a removed card only at its next tick.
    pin: (id: string, on: boolean) => void (on ? pins.add(id) : pins.delete(id)),
    setPreview: (id: string, x: number, y: number, w: number, h: number, rot: number) =>
      void previews.set(id, { x, y, w, h, rot }),
    clearPreview: (id: string) => void previews.delete(id),
    previewRectOf: (id: string) => previews.get(id),
    get previewCount() {
      return previews.size;
    },
    fit,
  } as unknown as Stage;
  const it_ = new Interaction(host, stage, store, { guides: false, grid: false } as never, options);
  store.add(
    cards.map((c) => createElement({ media: { src: `${c.id}.jpg` }, ...c } as CardInit, c.id)),
  );

  const log = {
    gestures: [] as (string | null)[],
    clicks: [] as InteractionEvents['click'][],
    transforms: [] as InteractionEvents['transform'][],
    hovers: [] as (string | null)[],
    selections: [] as (readonly string[])[],
    deletes: [] as (readonly string[])[],
    order: [] as string[],
  };
  it_.events.on('gesture', (e) => {
    log.gestures.push(e.kind);
  });
  it_.events.on('click', (e) => {
    log.clicks.push(e);
    log.order.push('click');
  });
  it_.events.on('transform', (e) => void log.transforms.push(e));
  it_.events.on('delete', (e) => void log.deletes.push(e.ids));
  it_.events.on('hover', (e) => void log.hovers.push(e.id));
  it_.events.on('selection', (e) => {
    log.selections.push(e.ids);
    log.order.push('selection');
  });

  // A mouse with its button held reports `buttons: 1` on every move.
  const pointer = (type: string, x: number, y: number, init: MouseEventInit = {}) => {
    const buttons = type === 'pointerup' || type === 'pointercancel' ? 0 : 1;
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons, ...init });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    host.dispatchEvent(e);
  };
  const lostCapture = () => {
    const e = new Event('lostpointercapture', { bubbles: true });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    host.dispatchEvent(e);
  };
  const key = (k: string, init: KeyboardEventInit = {}) =>
    host.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  return { store, it_, cam, overlay, previews, pins, log, pointer, lostCapture, key, fit, runFrame: () => frame() };
}

const rectOf = (store: Store, id: string) => {
  const el = store.get(id);
  return el && { x: el.x, y: el.y, w: el.w, h: el.h };
};

describe('a card removed during a gesture', () => {
  it('leaves the rest of a drag going and out of its transform', () => {
    const { store, it_, pointer, previews, pins, log } = make({}, [CARD_A, CARD_B]);
    it_.setSelection(['a', 'b']);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    expect([...pins].sort()).toEqual(['a', 'b']);

    store.remove(['b']);
    expect([...pins]).toEqual(['a']);
    expect([...previews.keys()]).toEqual(['a']);
    pointer('pointermove', 90, 50);
    expect(previews.get('a')?.x).toBe(40);
    pointer('pointerup', 90, 50);

    expect(log.transforms).toHaveLength(1);
    expect([...log.transforms[0].rects.keys()]).toEqual(['a']);
    expect(rectOf(store, 'a')).toEqual({ x: 40, y: 0, w: 100, h: 100 });
    expect(pins.size).toBe(0);
    expect(previews.size).toBe(0);
  });

  it('cancels a drag whose cards are all gone: previews, pins and the gesture', () => {
    const { store, pointer, previews, pins, log } = make();
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    store.remove(['a']);
    expect(pins.size).toBe(0);
    expect(previews.size).toBe(0);
    expect(log.gestures).toEqual(['drag', null]);
    pointer('pointermove', 90, 50);
    pointer('pointerup', 90, 50);
    expect(log.transforms).toEqual([]);
  });

  it('cancels a resize whose card is removed under the pointer', () => {
    const { store, it_, pointer, previews, pins, log } = make({}, [{ ...CARD_A, aspectLocked: false }]);
    it_.setSelection(['a']);
    pointer('pointerdown', 100, 50);
    pointer('pointermove', 120, 50);
    expect(log.gestures).toEqual(['resize']);
    expect(pins.has('a')).toBe(true);
    store.remove(['a']);
    pointer('pointermove', 140, 50);
    pointer('pointerup', 140, 50);
    expect(log.gestures).toEqual(['resize', null]);
    expect(pins.size).toBe(0);
    expect(previews.size).toBe(0);
    expect(log.transforms).toEqual([]);
  });

  it('keeps resizing the others when one card of the selection goes', () => {
    const { store, it_, pointer, previews, pins, log } = make({}, [CARD_A, CARD_B]);
    it_.setSelection(['a', 'b']);
    // The south-east corner of the shared box (0, 0) .. (300, 100).
    pointer('pointerdown', 300, 100);
    pointer('pointermove', 330, 110);
    expect(log.gestures).toEqual(['resize']);
    store.remove(['b']);
    expect([...pins]).toEqual(['a']);
    pointer('pointermove', 360, 120);
    pointer('pointerup', 360, 120);
    expect(log.transforms).toHaveLength(1);
    expect([...log.transforms[0].rects.keys()]).toEqual(['a']);
    expect(pins.size).toBe(0);
    expect(previews.size).toBe(0);
  });

  it('ends a press on a card that is gone without a click', () => {
    const { store, pointer, log } = make();
    pointer('pointerdown', 50, 50);
    store.remove(['a']);
    pointer('pointerup', 50, 50);
    expect(log.clicks).toEqual([]);
  });
});

describe('the pins of a gesture', () => {
  it('a click on a resize handle without a move pins nothing afterwards', () => {
    const { it_, pointer, pins, previews, log } = make({}, [{ ...CARD_A, aspectLocked: false }]);
    it_.setSelection(['a']);
    pointer('pointerdown', 100, 50);
    expect(pins.has('a')).toBe(true);
    pointer('pointerup', 100, 50);
    expect(pins.size).toBe(0);
    expect(previews.size).toBe(0);
    expect(log.transforms).toEqual([]);
    expect(log.gestures).toEqual(['resize', null]);
  });

  it('a drag release unpins every dragged card, whatever happened to its preview', () => {
    const { it_, pointer, pins, previews, log } = make({}, [CARD_A, CARD_B]);
    it_.setSelection(['a', 'b']);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    previews.delete('b');
    pointer('pointerup', 70, 50);
    expect(pins.size).toBe(0);
    expect([...log.transforms[0].rects.keys()]).toEqual(['a']);
  });
});

describe('interaction.commit: false', () => {
  it('an arrow-key nudge only proposes the move', () => {
    const { store, it_, key, log } = make({ commit: false });
    it_.setSelection(['a']);
    key('ArrowRight');
    key('ArrowDown', { shiftKey: true });
    expect(rectOf(store, 'a')).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(log.transforms.map((t) => [t.kind, t.rects.get('a')])).toEqual([
      ['move', { x: 1, y: 0, w: 100, h: 100 }],
      ['move', { x: 0, y: 10, w: 100, h: 100 }],
    ]);
  });

  it('a drag writes nothing: not the move, not the order; transform carries the proposal and `toFront`', () => {
    const { store, pointer, log } = make({ commit: false }, [CARD_A, CARD_B]);
    const seen: unknown[] = [];
    store.subscribe((e) => seen.push(e.change));
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    // Still drawn on top while held.
    expect(store.rank('a')).toBeGreaterThan(store.rank('b'));
    pointer('pointerup', 70, 50);
    expect(seen).toEqual([]);
    expect(store.ids()).toEqual(['a', 'b']);
    expect(store.rank('a')).toBe(0);
    expect(rectOf(store, 'a')).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(log.transforms).toHaveLength(1);
    expect(log.transforms[0].kind).toBe('move');
    expect(log.transforms[0].toFront).toEqual(['a']);
    expect(log.transforms[0].rects.get('a')).toMatchObject({ x: 20, y: 0 });
  });

  it('Delete only proposes: the cards stay, `delete` carries the ids', () => {
    const { store, it_, key, log } = make({ commit: false });
    it_.setSelection(['a']);
    key('Delete');
    expect(store.size).toBe(1);
    expect(log.deletes).toEqual([['a']]);
  });

  it('writes the nudge to the store by default', () => {
    const { store, it_, key, log } = make();
    it_.setSelection(['a']);
    key('ArrowRight');
    expect(rectOf(store, 'a')).toEqual({ x: 1, y: 0, w: 100, h: 100 });
    expect(log.transforms).toHaveLength(1);
  });
});

describe('a gesture whose pointerup never arrives', () => {
  const startDrag = (m: ReturnType<typeof make>) => {
    m.pointer('pointerdown', 50, 50);
    m.pointer('pointermove', 70, 50);
    expect(m.pins.has('a')).toBe(true);
  };
  const dropped = (m: ReturnType<typeof make>) => {
    expect(m.pins.size).toBe(0);
    expect(m.previews.size).toBe(0);
    expect(m.log.gestures).toEqual(['drag', null]);
    // Nothing was committed: a lost release is dropped like a pointercancel.
    expect(rectOf(m.store, 'a')).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(m.log.transforms).toEqual([]);
  };

  it('a mouse move with no button down ends it', () => {
    const m = make();
    startDrag(m);
    m.pointer('pointermove', 90, 50, { buttons: 0 });
    dropped(m);
    // Moving on does not bring it back.
    m.pointer('pointermove', 120, 50);
    expect(m.previews.size).toBe(0);
  });

  it('a lost pointer capture ends it', () => {
    const m = make();
    startDrag(m);
    m.lostCapture();
    dropped(m);
  });

  it('a window blur ends it, and the next press starts from nothing', () => {
    const m = make();
    startDrag(m);
    window.dispatchEvent(new Event('blur'));
    dropped(m);
    m.pointer('pointerdown', 50, 50);
    m.pointer('pointerup', 50, 50);
    expect(m.log.clicks.map((c) => c.id)).toEqual(['a']);
  });

  it('a window blur ends a pan, with no inertia', () => {
    const m = make();
    m.pointer('pointerdown', 300, 300);
    window.dispatchEvent(new Event('blur'));
    expect(m.cam.dragEnd).toHaveBeenCalledTimes(1);
    expect(m.cam.dragEnd.mock.calls[0][0]).toBeLessThan(0);
    expect(m.log.gestures).toEqual(['pan', null]);
  });

  it('a new press drops the gesture it finds still running', () => {
    const m = make({}, [CARD_A, CARD_B]);
    startDrag(m);
    m.pointer('pointerdown', 250, 50);
    expect(m.pins.size).toBe(0);
    expect(m.previews.size).toBe(0);
    expect(m.log.gestures).toEqual(['drag', null]);
    m.pointer('pointerup', 250, 50);
    expect(m.log.clicks.map((c) => c.id)).toEqual(['b']);
  });

  it('stops listening to the window when disposed', () => {
    const m = make();
    m.pointer('pointerdown', 300, 300);
    m.it_.dispose();
    // The pan in progress is ended by dispose itself, once; the window is not listened to any more.
    expect(m.cam.dragEnd).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('blur'));
    expect(m.cam.dragEnd).toHaveBeenCalledTimes(1);
  });
});

describe('click on the empty canvas', () => {
  it('is emitted for a press and release in marquee mode', () => {
    const { pointer, log } = make({ emptyDrag: 'marquee' });
    pointer('pointerdown', 300, 300);
    pointer('pointerup', 300, 300);
    expect(log.clicks).toEqual([{ id: null, shift: false, x: 300, y: 300 }]);
  });

  it('is emitted for a Shift click, which draws a marquee instead of panning', () => {
    const { pointer, log } = make();
    pointer('pointerdown', 300, 300, { shiftKey: true });
    pointer('pointerup', 300, 300, { shiftKey: true });
    expect(log.gestures).toEqual(['marquee', null]);
    expect(log.clicks).toEqual([{ id: null, shift: true, x: 300, y: 300 }]);
  });

  it('is not emitted after a marquee drag', () => {
    const { pointer, log } = make({ emptyDrag: 'marquee' });
    pointer('pointerdown', 300, 300);
    pointer('pointermove', 360, 340);
    pointer('pointerup', 360, 340);
    expect(log.clicks).toEqual([]);
  });

  it('is not emitted after dragging a locked card', () => {
    const { pointer, log } = make({}, [{ ...CARD_A, locked: true }]);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    pointer('pointerup', 70, 50);
    expect(log.gestures).toEqual(['pan', null]);
    expect(log.clicks).toEqual([]);
  });

  it('a click on a locked card still clicks the card', () => {
    const { pointer, log } = make({}, [{ ...CARD_A, locked: true }]);
    pointer('pointerdown', 50, 50);
    pointer('pointerup', 50, 50);
    expect(log.clicks.map((c) => c.id)).toEqual(['a']);
  });
});

describe('the handles follow the zoom', () => {
  // 400 x 400 is 20 px at 5 %: too short for edge handles.
  const big: Init = { id: 'a', x: 0, y: 0, w: 400, h: 400, aspectLocked: false };

  it('the east edge resizes after zooming in, even before a frame ran', () => {
    const { it_, cam, runFrame, pointer, log } = make({}, [big]);
    cam.scale = 0.05;
    it_.setSelection(['a']);
    runFrame();
    cam.scale = 1;
    pointer('pointerdown', 400, 200);
    expect(log.gestures).toEqual(['resize']);
  });

  it('the hover cursor of the east edge appears after zooming in', () => {
    const { it_, cam, runFrame, pointer } = make({}, [big]);
    cam.scale = 0.05;
    it_.setSelection(['a']);
    runFrame();
    pointer('pointermove', 400, 200, { buttons: 0 });
    expect(host.style.cursor).not.toBe('ew-resize');
    cam.scale = 1;
    runFrame();
    pointer('pointermove', 400, 201, { buttons: 0 });
    expect(host.style.cursor).toBe('ew-resize');
  });
});

describe('Shift on a selected card', () => {
  it('a drag moves the whole selection, the pressed card included', () => {
    const { store, it_, pointer, log, previews } = make({}, [CARD_A, CARD_B]);
    it_.setSelection(['a', 'b']);
    pointer('pointerdown', 50, 50, { shiftKey: true });
    // Still selected while the button is down.
    expect(it_.selection).toEqual(['a', 'b']);
    pointer('pointermove', 70, 50, { shiftKey: true });
    expect([...previews.keys()].sort()).toEqual(['a', 'b']);
    pointer('pointerup', 70, 50, { shiftKey: true });
    expect(it_.selection).toEqual(['a', 'b']);
    expect([...log.transforms[0].rects.keys()].sort()).toEqual(['a', 'b']);
    expect(store.get('a')?.x).toBe(20);
    expect(store.get('b')?.x).toBe(220);
  });

  it('a click without a drag takes it out of the selection, before the click event', () => {
    const { it_, pointer, log } = make({}, [CARD_A, CARD_B]);
    it_.setSelection(['a', 'b']);
    log.order.length = 0;
    pointer('pointerdown', 50, 50, { shiftKey: true });
    expect(it_.selection).toEqual(['a', 'b']);
    pointer('pointerup', 50, 50, { shiftKey: true });
    expect(it_.selection).toEqual(['b']);
    expect(log.order).toEqual(['selection', 'click']);
    expect(log.clicks.map((c) => [c.id, c.shift])).toEqual([['a', true]]);
  });

  it('on a card that is not selected it still adds it when pressed', () => {
    const { it_, pointer } = make({}, [CARD_A, CARD_B]);
    it_.setSelection(['b']);
    pointer('pointerdown', 50, 50, { shiftKey: true });
    expect(it_.selection).toEqual(['b', 'a']);
    pointer('pointerup', 50, 50, { shiftKey: true });
    expect(it_.selection).toEqual(['b', 'a']);
  });
});

describe('hover', () => {
  it('is cleared when the hovered card is removed', () => {
    const { store, pointer, log, overlay } = make();
    pointer('pointermove', 50, 50, { buttons: 0 });
    expect(log.hovers).toEqual(['a']);
    store.remove(['a']);
    expect(log.hovers).toEqual(['a', null]);
    expect(overlay.setHover).toHaveBeenLastCalledWith(null);
  });

  it('is left alone when another card is removed', () => {
    const { store, pointer, log } = make({}, [CARD_A, CARD_B]);
    pointer('pointermove', 50, 50, { buttons: 0 });
    store.remove(['b']);
    expect(log.hovers).toEqual(['a']);
  });
});

describe('the selection while a layout animation moves its cards', () => {
  it('follows the previews, hides the handles, and ends on the stored rects', () => {
    const { it_, overlay, previews, runFrame } = make({}, [{ ...CARD_A, x: 400, y: 300 }]);
    it_.setSelection(['a']);
    const last = () => overlay.setSelection.mock.calls.at(-1)?.[0];
    // The layout wrote x = 400 to the store and draws the card from x = 0 towards it.
    previews.set('a', { x: 0, y: 300, w: 100, h: 100, rot: 0 });
    runFrame();
    expect(last().frame.x).toBe(0);
    expect(last().showHandles).toBe(false);
    // No store change, only a new preview: the next frame still moves the outline.
    previews.set('a', { x: 150, y: 300, w: 100, h: 100, rot: 0 });
    runFrame();
    expect(last().frame.x).toBe(150);
    // The animation ends: the previews go, the outline lands on the store's rect, handles are back.
    previews.clear();
    runFrame();
    expect(last().frame.x).toBe(400);
    expect(last().showHandles).toBe(true);
  });
});

describe('the 0 key', () => {
  it('fits the board, but not an empty one (that would zoom in on the origin)', () => {
    const empty = make({}, []);
    empty.key('0');
    expect(empty.fit).not.toHaveBeenCalled();
    empty.it_.dispose();

    const full = make();
    full.key('0');
    expect(full.fit).toHaveBeenCalledTimes(1);
  });
});

describe('change source of what a gesture writes', () => {
  const changes = (store: Store) => {
    const seen: { source: string; updated: string[][]; removed: string[]; order?: string[] }[] = [];
    store.subscribe((e) => {
      const c = e.change;
      seen.push({
        source: c.source,
        updated: c.updated.map((u) => [...u.props]),
        removed: c.removed.map((r) => r.id),
        order: c.order?.moved.map((m) => m.id),
      });
    });
    return seen;
  };

  it('a drag is ONE change: the move and the bring-to-front together, "user"; the lift in between writes nothing', () => {
    const { store, pointer } = make({}, [CARD_A, CARD_B]);
    const seen = changes(store);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    // Held: drawn on top, but the store has not been written.
    expect(seen).toEqual([]);
    expect(store.ids()).toEqual(['a', 'b']);
    expect(store.rank('a')).toBeGreaterThan(store.rank('b'));
    pointer('pointerup', 70, 50);
    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe('user');
    expect(seen[0].updated.flat()).toContain('x');
    expect(seen[0].order).toEqual(['a']);
    expect(store.ids()).toEqual(['b', 'a']);
    expect(store.rank('a')).toBe(1);
  });

  it('a drag of the card already on top is one change with no order', () => {
    const { store, pointer } = make({}, [CARD_B, CARD_A]);
    const seen = changes(store);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    pointer('pointerup', 70, 50);
    expect(seen).toHaveLength(1);
    expect(seen[0].order).toBeUndefined();
  });

  it('a cancelled drag writes nothing and drops the lift', () => {
    const { store, pointer } = make({}, [CARD_A, CARD_B]);
    const seen = changes(store);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    window.dispatchEvent(new Event('blur'));
    expect(seen).toEqual([]);
    expect(store.rank('a')).toBe(0);
  });

  it('an arrow-key nudge and the Delete key are "user"', () => {
    const { store, it_, key } = make();
    const seen = changes(store);
    it_.setSelection(['a']);
    key('ArrowRight');
    key('Delete');
    expect(seen.map((c) => c.source)).toEqual(['user', 'user']);
    expect(seen[1].removed).toEqual(['a']);
  });
});

describe('setOptions', () => {
  it('applies at once when no gesture is running', () => {
    const { store, it_, key } = make();
    it_.setSelection(['a']);
    it_.setOptions({ keyboard: false });
    key('ArrowRight');
    expect(store.get('a')?.x).toBe(0);
    it_.setOptions({ keyboard: true, commit: undefined });
    key('ArrowRight');
    expect(store.get('a')?.x).toBe(1);
  });

  it('never alters a running gesture: the change waits for the next pointer down', () => {
    const { store, pointer, it_ } = make({}, [CARD_A]);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    it_.setOptions({ commit: false });
    pointer('pointerup', 70, 50);
    // The drag began with `commit: true`, so it was written.
    expect(store.get('a')?.x).toBe(20);
    pointer('pointerdown', 70, 50);
    pointer('pointermove', 100, 50);
    pointer('pointerup', 100, 50);
    // The next one runs with the new option: proposed, not written.
    expect(store.get('a')?.x).toBe(20);
  });
});

describe('a drag cut short from outside', () => {
  it('dispose() mid-drag drops the lift, the previews and the pins', () => {
    const { store, it_, pointer, previews, pins } = make({}, [CARD_A, CARD_B]);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    expect(store.rank('a')).toBeGreaterThan(store.rank('b'));
    expect([...pins]).toEqual(['a']);
    it_.dispose();
    expect(store.rank('a')).toBe(0);
    expect(store.rank('b')).toBe(1);
    expect(pins.size).toBe(0);
    expect(previews.size).toBe(0);
    expect(store.get('a')?.x).toBe(0);
  });

  it('a card added while a card is held draws below it', () => {
    const { store, pointer } = make({}, [CARD_A, CARD_B]);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    store.add([createElement({ media: { src: 'c.jpg' }, id: 'c', x: 0, y: 300, w: 100, h: 100 } as CardInit, 'c')]);
    expect(store.rank('c')).toBe(2);
    expect(store.rank('a')).toBeGreaterThan(store.rank('c'));
    pointer('pointerup', 70, 50);
    expect(store.ids()).toEqual(['b', 'c', 'a']);
  });

  it('a snapshot loaded mid-drag wins over the release', () => {
    const { store, it_, pointer, previews, pins, log } = make({}, [CARD_A, CARD_B]);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 70, 50);
    // What `loadSnapshot` does: the same ids, other positions.
    store.replaceAll(store.ids().map((id, i) => ({ ...(store.get(id) as Card), x: 1000 + i * 500 })));
    expect(log.gestures.at(-1)).toBeNull();
    expect(pins.size).toBe(0);
    expect(previews.size).toBe(0);
    pointer('pointermove', 90, 50);
    pointer('pointerup', 90, 50);
    expect(store.get('a')?.x).toBe(1000);
    expect(store.get('b')?.x).toBe(1500);
    expect(log.transforms).toEqual([]);
    expect(store.ids()).toEqual(['a', 'b']);
    // And the layer is still usable.
    pointer('pointerdown', 1050, 50);
    pointer('pointermove', 1070, 50);
    pointer('pointerup', 1070, 50);
    expect(store.get('a')?.x).toBe(1020);
    it_.dispose();
  });
});
