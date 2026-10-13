// The options a host that draws its own chrome needs from the interaction layer: no marquee, no canvas
// selection outline, a selection that survives a pan, and a hand tool it can switch. Pointer events are
// dispatched on the host against a real Store and a stub stage that records what the camera is asked to do.
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The controller only needs GRID from the stage module; loading Pixi in jsdom is noise.
vi.mock('../../src/render/stage', () => ({ GRID: 24 }));
import { Interaction, type InteractionOptions } from '../../src/interact/controller';
import { createElement } from '../../src/model';
import type { Stage } from '../../src/render/stage';
import { Store } from '../../src/store';

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  host = document.getElementById('host') as HTMLElement;
});

function make(options: InteractionOptions = {}, locked = true) {
  const store = new Store();
  const setSelection = vi.fn();
  const setMarquee = vi.fn();
  const cam = { scale: 1, dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), visibleRect: () => ({}) };
  const stage = {
    onFrame: (fn: () => void) => {
      frame = fn;
      return () => {};
    },
    requestFrame: () => {},
    overlay: {
      setSelection,
      setHover: () => {},
      setGuides: () => {},
      setMarquee,
    },
    cam,
    screenToWorld: (x: number, y: number) => ({ x, y }),
    clientToLocal: (x: number, y: number) => ({ x, y }),
    pin: () => {},
    setPreview: () => {},
    clearPreview: () => {},
    previewRectOf: () => undefined,
  } as unknown as Stage;
  let frame: () => void = () => {};
  const it_ = new Interaction(host, stage, store, { guides: false, grid: false } as never, options);
  // A card at (0, 0, 100, 100); the rest of the plane is empty canvas.
  store.add([createElement({ x: 0, y: 0, w: 100, h: 100, locked, media: { src: 'a.jpg' } }, 'a')]);
  const pointer = (type: string, x: number, y: number, init: MouseEventInit = {}) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...init });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    host.dispatchEvent(e);
  };
  return { store, it_, cam, setSelection, setMarquee, pointer, runFrame: () => frame() };
}

describe('Interaction.marquee', () => {
  it('Shift-drag on empty canvas draws a marquee by default', () => {
    const { pointer, setMarquee, cam } = make();
    pointer('pointerdown', 300, 300, { shiftKey: true });
    pointer('pointermove', 340, 340, { shiftKey: true });
    expect(setMarquee.mock.calls.some(([box]) => box !== null)).toBe(true);
    expect(cam.dragStart).not.toHaveBeenCalled();
  });

  it('with marquee: false a drag on empty canvas pans, Shift or not', () => {
    const { pointer, setMarquee, cam } = make({ marquee: false });
    pointer('pointerdown', 300, 300, { shiftKey: true });
    pointer('pointermove', 340, 340, { shiftKey: true });
    pointer('pointerup', 340, 340, { shiftKey: true });
    // Only the reset at the end of a gesture; no box was ever drawn.
    expect(setMarquee.mock.calls.every(([box]) => box === null)).toBe(true);
    expect(cam.dragStart).toHaveBeenCalledTimes(1);
    expect(cam.dragMove).toHaveBeenCalled();
  });
});

describe('Interaction.setPanMode', () => {
  it('pans from over a card instead of selecting it, until switched off', () => {
    const { pointer, it_, cam } = make();
    it_.setPanMode(true);
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 90, 90);
    pointer('pointerup', 90, 90);
    expect(it_.selection).toEqual([]);
    expect(cam.dragStart).toHaveBeenCalledTimes(1);

    it_.setPanMode(false);
    pointer('pointerdown', 50, 50);
    expect(it_.selection).toEqual(['a']);
  });
});

describe('Interaction.keepSelectionOnPan', () => {
  it('clears the selection as the pointer goes down on empty canvas by default', () => {
    const { pointer, it_ } = make();
    it_.setSelection(['a']);
    pointer('pointerdown', 300, 300);
    expect(it_.selection).toEqual([]);
  });

  it('keeps it through a pan and clears it on a click that does not move', () => {
    const { pointer, it_ } = make({ keepSelectionOnPan: true });
    it_.setSelection(['a']);
    pointer('pointerdown', 300, 300);
    pointer('pointermove', 360, 330);
    pointer('pointerup', 360, 330);
    expect(it_.selection).toEqual(['a']);

    pointer('pointerdown', 300, 300);
    pointer('pointerup', 300, 300);
    expect(it_.selection).toEqual([]);
  });

  it('a Shift click on empty canvas leaves the selection alone', () => {
    const { pointer, it_ } = make({ keepSelectionOnPan: true });
    it_.setSelection(['a']);
    pointer('pointerdown', 300, 300, { shiftKey: true });
    pointer('pointerup', 300, 300, { shiftKey: true });
    expect(it_.selection).toEqual(['a']);
  });
});

describe('Interaction.selectionOutline', () => {
  it('draws the selection on the canvas by default', () => {
    const { it_, setSelection, runFrame } = make({}, false);
    it_.setSelection(['a']);
    runFrame();
    expect(setSelection).toHaveBeenLastCalledWith(expect.objectContaining({ frame: expect.anything() }));
  });

  it('with selectionOutline: false the canvas draws no selection, the layer still selects', () => {
    const { it_, setSelection, runFrame, pointer } = make({ selectionOutline: false }, false);
    pointer('pointerdown', 50, 50);
    runFrame();
    expect(it_.selection).toEqual(['a']);
    expect(setSelection).toHaveBeenLastCalledWith(null);
  });
});
