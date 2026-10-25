/**
 * @packageDocumentation
 * @experimental
 *
 * `@niccolofanton/corkboard/unstable`: the building blocks the board is made of, for hosts that need more than
 * the root API (a custom renderer around the stage, the pure layout and snapping functions on their own, a
 * replacement for the video or embed layers...).
 *
 * NO SEMVER GUARANTEE. Everything exported here may change shape, move or disappear in any minor release.
 * The root entry (`@niccolofanton/corkboard`) is the supported API.
 */

// The parts of a board.
export { getInternals } from './internals';
export type { BoardInternals } from './internals';
// Extra DOM layers on a board, for a new kind of card that needs live DOM.
export { addOverlay } from './overlay';
export type { Overlay, OverlayContext, OverlayFactory } from './overlay';
// Profiling counters of the stage (`board.stats().debug`).
export type { DebugStats } from './stats';
export { Stage, GRID } from './render/stage';
export type { StageOptions } from './render/stage';
export { Store } from './store';
export type { ChangeSet, StoreEvent } from './store';
export { Interaction } from './interact/controller';
export { hitTest } from './interact/hitTest';
export { elementsInBox } from './interact/marquee';
export type { Aabb } from './interact/geometry';
export { VideoLayer } from './video/layer';
export { FrameRateMonitor } from './render/frameRate';
export type { FrameWindow, FrameRateDeps } from './render/frameRate';

// Pure layout and snapping functions.
export * from './layout/index';
export {
  buildSnapIndex,
  snapMove,
  snapResize,
  SNAP_THRESHOLD_PX,
  GUIDE_OVERSHOOT_PX,
} from './interact/snapping';
export type { Guide, LineGuide, MeasureGuide, SnapResult, SnapIndex } from './interact/snapping';

// The embed layer and its pure rules.
export * from './embed/index';
