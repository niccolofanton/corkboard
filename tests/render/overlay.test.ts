import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Pixi's Text measures with a canvas 2D context, which jsdom does not have: the pill label is a stub
// (7 px per character), and the constructor count tells whether the pool grows.
const made = vi.hoisted(() => ({ texts: 0 }));
vi.mock('pixi.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('pixi.js')>();
  class FakeText extends real.Container {
    text: string;
    style: { fill: unknown };
    constructor(o: { text?: string; style?: { fill: unknown } }) {
      super();
      made.texts++;
      this.text = o.text ?? '';
      this.style = o.style ?? { fill: 0 };
    }
    override get width(): number {
      return this.text.length * 7;
    }
  }
  return { ...real, Text: FakeText };
});
import { OverlayLayer } from '../../src/render/overlay';
import { DARK_THEME } from '../../src/render/theme';
import type { Guide } from '../../src/interact/snapping';

const CAM = { tx: 10, ty: 20, scale: 2 };

const line: Guide = { axis: 'x', at: 30, from: 0, to: 50, kind: 'edge' };

let overlay: OverlayLayer;
beforeEach(() => {
  made.texts = 0;
  overlay = new OverlayLayer(DARK_THEME);
});

// The guides themselves are tested in guides.test.ts: here, only how the overlay hosts them.
describe('OverlayLayer guides', () => {
  it('hosts the guide layer above its own Graphics and reports what it shows', () => {
    expect(overlay.container.children).toHaveLength(2);
    overlay.setGuides([line]);
    expect(overlay.guideCount).toBe(1);
    expect(overlay.active).toBe(true);
    expect(overlay.draw(CAM)).toBe(true);
    overlay.setGuides([]);
    // Fading out: still on screen, no longer counted.
    expect(overlay.guideCount).toBe(0);
    expect(overlay.active).toBe(true);
  });
});

// The stage parks its loop when nothing moves and the overlay is drawn inside its tick: any change of
// the overlay's state has to ask for a frame, or it stays undrawn until something else wakes the loop.
describe('OverlayLayer wake', () => {
  const sel = {
    frame: { x: 0, y: 0, w: 10, h: 10, rot: 0 },
    members: [],
    handles: [],
    showHandles: false,
  };
  const rect = { x: 0, y: 0, w: 10, h: 10, rot: 0 };
  let wake: Mock<() => void>;
  beforeEach(() => {
    wake = vi.fn();
    overlay = new OverlayLayer(DARK_THEME, wake);
  });

  it('asks for a frame on every change of state', () => {
    overlay.setSelection(sel);
    expect(wake).toHaveBeenCalledTimes(1);
    overlay.setHover(rect);
    expect(wake).toHaveBeenCalledTimes(2);
    overlay.setMarquee({ minX: 0, minY: 0, maxX: 5, maxY: 5 });
    expect(wake).toHaveBeenCalledTimes(3);
    overlay.setGuides([line]);
    expect(wake).toHaveBeenCalledTimes(4);
    overlay.invalidate();
    expect(wake).toHaveBeenCalledTimes(5);
    overlay.setTheme(DARK_THEME);
    expect(wake).toHaveBeenCalledTimes(6);
  });

  it('stays asleep when a clear changes nothing', () => {
    overlay.setHover(null);
    overlay.setMarquee(null);
    overlay.setGuides([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it('draws the selection it was woken for', () => {
    overlay.draw(CAM);
    overlay.setSelection(sel);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(overlay.draw(CAM)).toBe(true);
    // Nothing changed since: the next frame has nothing to redraw.
    expect(overlay.draw(CAM)).toBe(false);
  });
});
