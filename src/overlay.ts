// DOM overlays: layers of real DOM laid over the canvas and synced to the camera in the same animation
// frame as the render. The video layer is one (src/video/layer.ts). A new element kind that needs live
// DOM (an iframe, an HTML card) is one `Overlay`, added with `addOverlay` from
// `@niccolofanton/corkboard/unstable`, next to its view in src/render/views/registry.ts.
import { CorkboardError } from './errors';
import type { Corkboard } from './Corkboard';
import { getInternals } from './internals';
import type { Stage } from './render/stage';
import type { Store } from './store';

/** What an overlay factory is given. */
export interface OverlayContext {
  /**
   * A div that covers the canvas (`position: absolute; inset: 0; overflow: hidden; pointer-events:
   * none`). Put elements in it; position them with the camera's transform (`stage.cam.cam`).
   */
  root: HTMLElement;
  store: Store;
  stage: Stage;
}

/** A DOM layer synced to the camera in the same animation frame as the render (see {@link OverlayFactory}). */
export interface Overlay {
  /**
   * Every animation frame the stage ticks, after the camera step. `camChanged` is true when the camera
   * moved since the previous frame.
   */
  onFrame?(camChanged: boolean): void;
  /** The camera has been still for a moment. */
  onSettle?(): void;
  /** Removes the overlay's DOM and listeners. Called by the disposer {@link addOverlay} returns, or by `board.dispose()`. */
  dispose(): void;
}

/** Makes an extra DOM overlay for a board (see {@link addOverlay}): a new element kind that needs live DOM. */
export type OverlayFactory = (ctx: OverlayContext) => Overlay;

/**
 * Adds a DOM overlay to a board, at any time after `create`: `factory` is called now with the overlay root,
 * the store and the stage, and the overlay it returns gets the frame and settle ticks until it is removed.
 *
 * @returns The function that removes the overlay (calls its `dispose`); idempotent. `board.dispose()` removes
 *   every overlay that is still there.
 * @throws {CorkboardError} `'disposed'` on a disposed board; whatever `factory` throws (nothing is added then).
 */
export function addOverlay(board: Corkboard, factory: OverlayFactory): () => void {
  const parts = getInternals(board);
  if (parts.isDisposed()) throw new CorkboardError('disposed', 'Corkboard: the board has been disposed');
  const overlay = factory({ root: parts.overlayRoot, store: parts.store, stage: parts.stage });
  const offFrame = parts.stage.onFrame((camChanged) => overlay.onFrame?.(camChanged));
  const offSettle = parts.stage.onSettle(() => overlay.onSettle?.());
  let removed = false;
  const unregister = parts.onDispose(() => remove());
  function remove(): void {
    if (removed) return;
    removed = true;
    unregister();
    offFrame();
    offSettle();
    overlay.dispose();
  }
  return remove;
}
