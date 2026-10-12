// The interaction overlay: everything that must stay crisp and constant-size at every zoom, drawn in
// SCREEN space on top of the world: selection outlines and handles, the hover outline, the marquee and
// the snapping guides.
//
// State is set by the interaction layer in WORLD coordinates and the overlay converts with the camera
// at draw time, so a pan with a live selection only costs a redraw of a few lines. One Graphics,
// cleared and redrawn when the state or the camera changed (`draw` returns whether it did). The smart
// guides are their own layer on top (render/guides.ts): hairlines, marks and label pills that fade in
// and out on their own clock.
//
// The overlay is drawn by the stage tick and the stage parks its loop when nothing moves, so every change
// of state wakes it (`wake`): a caller that sets the selection, the hover or a guide never has to remember
// to ask for a frame.
import { Container, Graphics } from 'pixi.js';
import type { Camera } from '../math';
import type { Box } from '../interact/geometry';
import type { Handle } from '../interact/handles';
import { outlinePoints, type OutlineRect } from '../interact/outline';
import type { Guide } from '../interact/snapping';
import { GuideLayer } from './guides';
import type { Theme } from './theme';

export const HANDLE_SIZE = 8;
const OUTLINE = 1.5;

export interface SelectionVisual {
  // The rect the handles sit on (rotated for a single element): the 1.5 px outline. A single element's
  // carries its corner radius, a multi-selection's box is square.
  frame: OutlineRect;
  // Per-element thin outlines for a multi-selection (empty for a single element), each with its radius.
  members: OutlineRect[];
  handles: readonly Handle[];
  // The handles are hidden while a gesture runs (a resize in progress shows the frame only).
  showHandles: boolean;
}

const noop = (): void => {};

export class OverlayLayer {
  readonly container = new Container();
  private readonly g = new Graphics();
  private theme: Theme;
  private selection: SelectionVisual | null = null;
  private hover: OutlineRect | null = null;
  private marquee: Box | null = null;
  private dirty = true;
  private lastCam = { tx: NaN, ty: NaN, scale: NaN };
  private readonly guides: GuideLayer;
  // Scratch for the outline polygons.
  private readonly pts: number[] = [];

  constructor(
    theme: Theme,
    // Asks the stage for a frame: called whenever the overlay has something new to draw.
    private readonly wake: () => void = noop,
    // The renderer's pixel ratio: the guides' hairlines are one device pixel.
    dpr = 1,
  ) {
    this.theme = theme;
    this.container.eventMode = 'none';
    this.g.eventMode = 'none';
    this.guides = new GuideLayer(theme, dpr);
    this.container.addChild(this.g, this.guides.container);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.guides.setTheme(theme);
    this.invalidate();
  }

  setSelection(s: SelectionVisual | null): void {
    this.selection = s;
    this.invalidate();
  }

  setHover(r: OutlineRect | null): void {
    if (r === null && this.hover === null) return;
    this.hover = r;
    this.invalidate();
  }

  // World-space box.
  setMarquee(b: Box | null): void {
    if (b === null && this.marquee === null) return;
    this.marquee = b;
    this.invalidate();
  }

  // Smart guides (world units). The same guides again cost nothing; a change asks for a frame.
  setGuides(g: readonly Guide[]): void {
    if (this.guides.set(g)) this.wake();
  }

  // The guides currently set (not counting the ones fading out): for tests and the demo.
  get guideCount(): number {
    return this.guides.count;
  }

  get currentGuides(): Guide[] {
    return this.guides.current;
  }

  get active(): boolean {
    return (
      this.selection !== null || this.hover !== null || this.marquee !== null || this.guides.active
    );
  }

  // Marks the next draw as needed and wakes the stage loop for it.
  invalidate(): void {
    this.dirty = true;
    this.wake();
  }

  // Redraws when something changed. Returns true when anything was rebuilt.
  draw(cam: Camera): boolean {
    const guides = this.guides.draw(cam, performance.now());
    // A fade keeps the frames coming until it is done.
    if (this.guides.animating) this.wake();
    const camChanged =
      cam.tx !== this.lastCam.tx || cam.ty !== this.lastCam.ty || cam.scale !== this.lastCam.scale;
    if (!this.dirty && !(camChanged && this.active)) return guides;
    this.lastCam.tx = cam.tx;
    this.lastCam.ty = cam.ty;
    this.lastCam.scale = cam.scale;
    this.dirty = false;
    const g = this.g;
    g.clear();
    const th = this.theme;
    const sx = (x: number): number => cam.tx + x * cam.scale;
    const sy = (y: number): number => cam.ty + y * cam.scale;

    if (this.hover) {
      this.rectPath(g, this.hover, cam);
      g.stroke({ width: 1, color: th.accent, alpha: 0.5 });
    }
    const sel = this.selection;
    if (sel) {
      for (const m of sel.members) {
        this.rectPath(g, m, cam);
        g.stroke({ width: 1, color: th.accent, alpha: 0.85 });
      }
      this.rectPath(g, sel.frame, cam);
      g.stroke({ width: OUTLINE, color: th.accent });
      if (sel.showHandles) {
        const h = HANDLE_SIZE;
        for (const hd of sel.handles) {
          const x = sx(hd.x);
          const y = sy(hd.y);
          g.rect(x - h / 2, y - h / 2, h, h);
          // Fill then stroke the same path: a white handle with an accent outline.
          g.fill({ color: 0xffffff }).stroke({ width: OUTLINE, color: th.accent });
        }
      }
    }
    if (this.marquee) {
      const b = this.marquee;
      const x0 = sx(Math.min(b.minX, b.maxX));
      const y0 = sy(Math.min(b.minY, b.maxY));
      g.rect(x0, y0, Math.abs(b.maxX - b.minX) * cam.scale, Math.abs(b.maxY - b.minY) * cam.scale);
      g.fill({ color: th.accent, alpha: 0.08 });
      g.rect(x0, y0, Math.abs(b.maxX - b.minX) * cam.scale, Math.abs(b.maxY - b.minY) * cam.scale);
      g.stroke({ width: 1, color: th.accent, alpha: 0.9 });
    }
    return true;
  }

  // A closed path along the outline of a world rect, in screen space: square or rounded corners (the
  // element's own radius scaled with the zoom).
  private rectPath(g: Graphics, r: OutlineRect, cam: Camera): void {
    g.poly(outlinePoints(r, cam, 0, this.pts), true);
  }
}
