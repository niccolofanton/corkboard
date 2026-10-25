// The supported API of the library. The building blocks (stage, store, pure layout and snapping functions,
// the embed and video layers) are in `@niccolofanton/corkboard/unstable`, without a semver guarantee.
export { Corkboard } from './Corkboard';
export { invertChange } from './change';
export type { ApplyChangeOptions } from './change';
export type { CameraRange, CorkboardOptions, CorkboardEvents, TextureOptions } from './Corkboard';
export type {
  ArrangeOptions,
  CameraApi,
  CameraMoveOptions,
  EmbedsApi,
  GridOptions,
  InteractionApi,
  LayoutApi,
  MasonryOptions,
  VideoApi,
} from './api';
export type { AlignMode } from './layout/align';
export { CorkboardError } from './errors';
export type { BoardErrorEvent, CorkboardErrorCode } from './errors';
export { SNAPSHOT_VERSION } from './snapshot';
export type { BoardSnapshot, BoardSnapshotInput, SnapshotCard, SnapshotCardInput } from './snapshot';
export type {
  BoardStats,
  EmbedStats,
  Percentiles,
  RenderStats,
  SlowTick,
  StageStats,
  TextureStats,
  VideoStats,
} from './stats';

export { DEFAULTS, MIN_SCALE, MAX_SCALE } from './types';
export type {
  Change,
  ChangeSource,
  Card,
  CardId,
  CardInit,
  CardKind,
  CardMedia,
  CardPatch,
  CardProp,
  CardUpdate,
  EmbedResolution,
  EmbedSource,
  CardMediaInput,
  OrderChange,
  OrderMove,
} from './types';
export type { Camera, Rect, Box } from './math';

export { DARK_THEME, LIGHT_THEME } from './render/theme';
export type { Theme } from './render/theme';

export type { InteractionOptions, InteractionEvents } from './interact/controller';
export type { SnapSettings } from './interact/snap';
export type { VideoOptions, VideoMode } from './video/layer';

// Embed cards: the pure URL helpers (to validate a user's input before it becomes a card) and the types of the
// `embeds` option and of `board.embeds`.
export { parseEmbedUrl, normalizeEmbedUrl } from './embed/providers';
export type { EmbedProvider } from './embed/providers';
export type { EmbedOptions, EmbedEvents } from './embed/layer';
export type { SnippetNetwork } from './embed/sandbox';
export type { PreviewCacheMode } from './embed/previewCache';
export type { EmbedInfo, EmbedResolver, ResolvedEmbed } from './embed/resolve';
