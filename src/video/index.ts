export { VideoOverlay, SPINNER_DELAY_MS, FADE_OUT_MS } from './video';
export type { VideoTarget, VideoOverlayOptions } from './video';
export { VideoController, HOVER_DELAY_MS, MIN_SCREEN_PX } from './videoController';
export type { VideoControllerDeps, VideoCardState } from './videoController';
export {
  AmbientVideos,
  REPLAN_THROTTLE_MS,
  STARTS_PER_PASS,
  START_SPACING_MS,
  MAX_IDLE,
} from './ambient';
export type { AmbientDeps } from './ambient';
export {
  planAmbient,
  ambientAllowed,
  browserAmbientEnv,
  AMBIENT_MAX_STREAMS,
  AMBIENT_MAX_PLAYING,
  AMBIENT_MAX_PLAYING_TOUCH,
  AMBIENT_MIN_PLAY_PX,
  AMBIENT_MARGIN,
} from './ambientPolicy';
export type { AmbientCandidate, AmbientPlanInput, AmbientEnv } from './ambientPolicy';
export { videoPlacement } from './videoGeometry';
export type { VideoRect, VideoPlacement } from './videoGeometry';
export { isPlayable, wantedPlayback } from './videoPolicy';
export type { PlaybackSource, PlaybackWant, PolicyInput } from './videoPolicy';
export {
  attachVideoReveal,
  createRevealSpinner,
  injectRevealStyles,
  INDICATOR_DELAY_MS,
} from './reveal';
export type { RevealState, VideoReveal, VideoRevealOptions } from './reveal';
