import type { Container, Graphics } from 'pixi.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pixi's Text measures with a canvas 2D context, which jsdom does not have: the pill label is a stub
// (7 px per character, 13 px tall), and the constructor count tells whether the pool grows.
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
    override get height(): number {
      return 13;
    }
  }
  return { ...real, Text: FakeText };
});
import { GUIDE_FADE_MS, GuideLayer, guideKey } from '../../src/render/guides';
import { DARK_THEME, GUIDE_DARK, GUIDE_LIGHT, LIGHT_THEME } from '../../src/render/theme';
import type { Guide, LineGuide } from '../../src/interact/snapping';

const CAM = { tx: 10, ty: 20, scale: 2 };

interface PillView extends Container {
  text: string;
  style: { fill: unknown };
}

// The children: the lines Graphics, the pill backgrounds, then the pooled label texts.
const linesOf = (l: GuideLayer): Graphics => l.container.children[0] as Graphics;
const pillsOf = (l: GuideLayer): PillView[] => l.container.children.slice(2) as PillView[];
const shown = (l: GuideLayer): string[] =>
  pillsOf(l)
    .filter((p) => p.visible)
    .map((p) => p.text);

const gap = (label: number, at = 5, from = 0, to = 100): Guide => ({
  axis: 'x',
  at,
  from,
  to,
  kind: 'gap',
  label,
});
const width = (axis: 'x' | 'y'): Guide => ({
  axis,
  at: 40,
  from: 0,
  to: 80,
  kind: 'width',
  label: 80,
});
const line = (at = 30, from = 0, to = 50): LineGuide => ({ axis: 'x', at, from, to, kind: 'edge' });

// Draw until the fades are done (fixed 16 ms steps from `t`); returns the time reached.
function settle(l: GuideLayer, t: number): number {
  let now = t;
  for (let i = 0; i < 20 && l.animating; i++) l.draw(CAM, (now += 16));
  return now;
}

let layer: GuideLayer;
beforeEach(() => {
  made.texts = 0;
  layer = new GuideLayer(DARK_THEME, 2);
});

describe('guideKey: what a guide is, not how far it runs', () => {
  it('an alignment line keeps its key while its span and marks change', () => {
    const a: Guide = { ...line(30, 0, 50), marks: [0, 50] };
    const b: Guide = { ...line(30, -40, 90), marks: [-40, 0, 50, 90] };
    expect(guideKey(a)).toBe(guideKey(b));
    expect(guideKey(line(31))).not.toBe(guideKey(a));
    expect(guideKey({ ...line(30), kind: 'center' })).not.toBe(guideKey(a));
  });

  it('a measure keeps its key while it slides across its segment', () => {
    expect(guideKey(gap(50, 5))).toBe(guideKey(gap(50, 60)));
    expect(guideKey(gap(50, 5, 0, 100))).not.toBe(guideKey(gap(50, 5, 10, 100)));
  });
});

describe('GuideLayer: changes and fades', () => {
  it('reports a change only when something on screen changes', () => {
    expect(layer.set([])).toBe(false);
    expect(layer.set([line()])).toBe(true);
    // The same guide again (a pointer move that stays snapped): nothing to redraw.
    expect(layer.set([line()])).toBe(false);
    expect(layer.set([line(30, 0, 60)])).toBe(true);
    expect(layer.set([])).toBe(true);
    expect(layer.set([])).toBe(false);
  });

  it(`fades a new guide in over ${GUIDE_FADE_MS} ms and an old one out, then drops it`, () => {
    layer.set([line()]);
    expect(layer.count).toBe(1);
    expect(layer.animating).toBe(true);
    expect(layer.draw(CAM, 1000)).toBe(true);
    // Still fading in after the first frame (16 ms of 80).
    expect(layer.animating).toBe(true);
    const t = settle(layer, 1000);
    expect(t - 1000).toBeLessThanOrEqual(GUIDE_FADE_MS + 16);
    expect(layer.animating).toBe(false);
    // Nothing changed since: no redraw.
    expect(layer.draw(CAM, t + 16)).toBe(false);

    layer.set([]);
    expect(layer.count).toBe(0);
    expect(layer.active).toBe(true); // still fading out
    const t2 = settle(layer, t + 16);
    expect(t2 - t - 16).toBeLessThanOrEqual(GUIDE_FADE_MS + 16);
    expect(layer.active).toBe(false);
  });

  it('a guide that comes back while fading out resumes instead of starting over', () => {
    layer.set([line()]);
    const t = settle(layer, 0);
    layer.set([]);
    layer.draw(CAM, t + 16); // one frame of the fade-out
    expect(layer.set([line()])).toBe(true);
    // Back to full in a frame or two, not a whole fade-in.
    layer.draw(CAM, t + 32);
    layer.draw(CAM, t + 48);
    expect(layer.animating).toBe(false);
  });

  it('redraws for a camera change while guides are shown', () => {
    layer.set([line()]);
    const t = settle(layer, 0);
    expect(layer.draw(CAM, t + 16)).toBe(false);
    expect(layer.draw({ ...CAM, tx: 40 }, t + 32)).toBe(true);
  });
});

describe('GuideLayer: device-pixel hairlines', () => {
  // A vertical line guide without marks: the lines Graphics holds just its hairline.
  const bounds = (l: GuideLayer): { x: number; w: number } => {
    const b = linesOf(l).getLocalBounds();
    return { x: b.minX, w: b.maxX - b.minX };
  };

  it('is exactly one device pixel wide, on the device pixel grid, at any pixel ratio', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      for (const tx of [10, 10.3, 10.77]) {
        const l = new GuideLayer(DARK_THEME, dpr);
        l.set([line(30.13)]);
        l.draw({ tx, ty: 20, scale: 1.7 }, 0);
        const { x, w } = bounds(l);
        expect(w).toBeCloseTo(1 / dpr, 6);
        expect(Math.abs(x * dpr - Math.round(x * dpr))).toBeLessThan(1e-6);
        // The device pixel the guide's screen position falls in.
        const sx = tx + 30.13 * 1.7;
        expect(x).toBeLessThanOrEqual(sx + 1e-6);
        expect(x + w).toBeGreaterThan(sx);
      }
    }
  });

  it('draws a cross at each mark, centred on the line', () => {
    const l = new GuideLayer(DARK_THEME, 2);
    l.set([{ ...line(30, 0, 50), marks: [0, 50] }]);
    l.draw(CAM, 0);
    const b = linesOf(l).getLocalBounds();
    // Screen x = 70; the crosses reach about 3 px either side of it.
    expect(b.minX).toBeGreaterThan(70 - 4);
    expect(b.maxX).toBeLessThan(70 + 4);
    expect(b.maxX - b.minX).toBeGreaterThan(4);
  });
});

describe('GuideLayer: measure pills', () => {
  it('labels a gap with its integer size and a width match with "="', () => {
    layer.set([gap(50), width('x'), width('y')]);
    layer.draw(CAM, 0);
    // The width pills of the two axes overlap (same box): only one of them is shown.
    expect(shown(layer)).toEqual(['50', '=']);
  });

  it('centres the pill on a long segment, in whole device pixels', () => {
    layer.set([gap(50)]);
    layer.draw(CAM, 0);
    const [p] = pillsOf(layer);
    // Segment: x 0..100 at y 5 -> screen x 10..210 at y 30. Pill: 16 px min width; "50" = 14 + 10 =
    // 24 wide, 16 tall; its label (14 x 13) is centred in it.
    const cx = p.position.x + 7;
    const cy = p.position.y + 6.5;
    expect(Math.abs(cx - 110)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(cy - 30.25)).toBeLessThanOrEqual(0.5);
    expect(Number.isInteger(p.position.x * 2)).toBe(true);
    expect(Number.isInteger(p.position.y * 2)).toBe(true);
  });

  it('moves the pill beside a segment too short to hold it', () => {
    // 6 world px = 12 screen px: shorter than the pill.
    layer.set([gap(6, 5, 0, 6)]);
    layer.draw(CAM, 0);
    const [p] = pillsOf(layer);
    // Below the segment (y = 30), not on it.
    expect(p.position.y).toBeGreaterThan(30 + 3);
  });

  it('reuses the pooled texts across redraws and hides the ones it no longer needs', () => {
    layer.set([gap(50), gap(20, 60, 200, 300), width('x')]);
    layer.draw(CAM, 0);
    expect(made.texts).toBe(3);
    layer.set([gap(51), gap(21, 60, 200, 300), width('y')]);
    layer.draw(CAM, 16);
    expect(made.texts).toBe(3);
    // Fewer: the extras stay pooled, hidden (the fading-out ones still show until they are gone).
    layer.set([gap(7)]);
    settle(layer, 32);
    expect(made.texts).toBe(3);
    expect(shown(layer)).toEqual(['7']);
    layer.set([]);
    settle(layer, 400);
    expect(shown(layer)).toEqual([]);
  });

  it('keeps the colours in step with the theme', () => {
    layer.set([gap(50)]);
    layer.draw(CAM, 0);
    const [p] = pillsOf(layer);
    expect(p.style.fill).toBe(0xffffff);
    layer.setTheme({ ...DARK_THEME, onGuide: 0x123456 });
    expect(p.style.fill).toBe(0x123456);
    expect(layer.draw(CAM, 16)).toBe(true);
  });
});

describe('guide colours', () => {
  it('has its own hue per mode, apart from the selection accent', () => {
    expect(DARK_THEME.guide).toBe(GUIDE_DARK);
    expect(LIGHT_THEME.guide).toBe(GUIDE_LIGHT);
    expect(GUIDE_DARK).not.toBe(DARK_THEME.accent);
    expect(GUIDE_LIGHT).not.toBe(LIGHT_THEME.accent);
  });
});
