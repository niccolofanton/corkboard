// DOM overlays: layers of real DOM laid over the canvas and synced to the camera in the same animation
// frame as the render. The video layer is one (src/video/layer.ts). A new element kind that needs live
// DOM (an iframe, an HTML card) is one `Overlay`, passed in `CorkboardOptions.overlays`, next to its
// view in src/render/views/registry.ts.
import type { Stage } from './render/stage';
import type { Store } from './store';

export interface OverlayContext {
  // A div that covers the canvas (`position: absolute; inset: 0; overflow: hidden; pointer-events:
  // none`). Put elements in it; position them with the camera's transform (`stage.cam.cam`).
  root: HTMLElement;
  store: Store;
  stage: Stage;
}

export interface Overlay {
  // Every animation frame the stage ticks, after the camera step. `camChanged` is true when the camera
  // moved since the previous frame.
  onFrame?(camChanged: boolean): void;
  // The camera has been still for a moment.
  onSettle?(): void;
  dispose(): void;
}

export type OverlayFactory = (ctx: OverlayContext) => Overlay;
