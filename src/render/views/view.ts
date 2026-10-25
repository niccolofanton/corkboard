// The contract between the stage and the per-kind display objects ("views").
//
// A view is a pooled bundle of Pixi objects that draws one element. The stage mounts a view for every
// element that is near the viewport (rbush query), keeps it in sync with the store, and returns it to
// its pool when the element leaves. Views never touch the store or the camera.
//
// All views place themselves the same way: `display.position` = the element's world CENTRE and
// `display.pivot` = (w / 2, h / 2), so rotation is about the centre and children are laid out in the
// element's own (0, 0, w, h) space.
import type { Container } from 'pixi.js';
import { DEG, type WorldRect } from '../../interact/geometry';
import type { Card, CardKind } from '../../types';
import type { Theme } from '../theme';

/** What a card view is drawn with. */
export interface ViewCtx {
  theme: Theme;
  dpr: number;
  // Camera scale (world px -> CSS px).
  scale: number;
  // Asks for a frame (a view finished something asynchronous).
  wake(): void;
  // A view changed Pixi state outside mount / update (a placeholder repaint, say): the stage must render
  // even though no store change or camera move asks for it.
  invalidate(): void;
}

/** The Pixi view of one card. */
export interface CardView {
  readonly kind: CardKind;
  // Which pool the view lives in (one per `ViewDefinition`).
  readonly variant: string;
  readonly display: Container;
  el: Card | null;
  // Last stage pass that found this view still near the viewport (set by the stage).
  mark: number;
  // Fill from `el` (acquired from the pool) at the given WORLD rect.
  mount(el: Card, rect: WorldRect, ctx: ViewCtx): void;
  // The element changed in the store. `props` are the changed property names; `rect` is the (possibly
  // previewed) world rect.
  update(el: Card, props: readonly string[], rect: WorldRect, ctx: ViewCtx): void;
  // Geometry only (a drag / resize preview, or a committed move): cheap.
  setRect(rect: WorldRect): void;
  // The theme changed: re-derive colours.
  refresh(ctx: ViewCtx): void;
  // A multiplier on the view's own opacity.
  setAlphaOverride(alpha: number): void;
  // Remove the view's state and make it reusable. The stage removes `display` from the world.
  unmount(): void;
}

// Places a container so it rotates about its centre: position = centre, pivot = (w / 2, h / 2).
export function placeCentered(c: Container, r: WorldRect): void {
  c.pivot.set(r.w / 2, r.h / 2);
  c.position.set(r.x + r.w / 2, r.y + r.h / 2);
  c.rotation = r.rot * DEG;
}
