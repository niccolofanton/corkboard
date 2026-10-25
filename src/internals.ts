// The way from a board to the parts it is made of, for the `unstable` entry (`getInternals`). The parts are not
// members of the `Corkboard` type: the board registers them here when it is built, and only this module's
// readers can find them.
import type { Corkboard } from './Corkboard';
import type { EmbedLayer } from './embed/layer';
import type { Interaction } from './interact/controller';
import type { Stage } from './render/stage';
import type { Store } from './store';
import type { VideoLayer } from './video/layer';

/** The parts a board is made of, as returned by {@link getInternals}. */
export interface BoardInternals {
  stage: Stage;
  store: Store;
  // null when the board was made with `interaction: false`.
  interaction: Interaction | null;
  embeds: EmbedLayer;
  video: VideoLayer;
  // The div that covers the canvas, for the DOM overlays (see `addOverlay`).
  overlayRoot: HTMLElement;
  // Whether `dispose()` ran.
  isDisposed(): boolean;
  // Registers a teardown step that `dispose()` runs; returns the function that unregisters it.
  onDispose(fn: () => void): () => void;
}

const registry = new WeakMap<Corkboard, BoardInternals>();

export function registerInternals(board: Corkboard, parts: BoardInternals): void {
  registry.set(board, parts);
}

/**
 * The stage, store, interaction layer, embed layer and video layer of a board. No stability promise: see
 * `@niccolofanton/corkboard/unstable`. Works on a disposed board too (the parts are then torn down).
 */
export function getInternals(board: Corkboard): BoardInternals {
  const parts = registry.get(board);
  if (!parts) throw new TypeError('getInternals: not a Corkboard');
  return parts;
}
