// The shapes of the objects a host talks to: `board.camera`, `board.layout`, `board.embeds`, `board.video` and
// `board.interaction`. They are interfaces on purpose: the classes behind them are internal (src/BoardCamera.ts,
// src/BoardLayout.ts), so a host cannot construct them and the board's own plumbing (`placeNew`,
// `cancelAnimation`, the stage, the store) stays out of reach. For the internals see `getInternals` in
// `@niccolofanton/corkboard/unstable`.
import type { Camera, Rect } from './math';
import type { AlignMode } from './layout/align';
import type { EmbedOptions } from './embed/layer';
import type { ResolvedEmbed } from './embed/resolve';
import type { InteractionOptions } from './interact/controller';
import type { CardId } from './types';
import type { VideoOptions } from './video/layer';

/** Options of the camera moves that can animate. */
export interface CameraMoveOptions {
  /**
   * Animate the move.
   * @default true
   */
  animate?: boolean;
  /**
   * Screen px kept free around the target.
   * @default 48
   */
  padding?: number;
}

/**
 * Camera control, `board.camera`. A camera is `{ tx, ty, scale }`: a world point (wx, wy) shows at
 * (tx + wx * scale, ty + wy * scale) in host-local CSS px. The scale stays within the `camera` option's range.
 * Every method throws a `CorkboardError` (`'disposed'`) after `dispose()`.
 */
export interface CameraApi {
  /** The camera now (a copy). */
  get(): Camera;
  /**
   * Jumps to a camera, without animation. The scale is held to the zoom range.
   *
   * @throws {CorkboardError} `'invalid'` when `tx` or `ty` is not a finite number or `scale` is not a finite
   *   number > 0.
   */
  set(c: Camera): void;
  /**
   * Fits the given cards (default: all) in the view. With nothing to fit (an empty board, or none of the ids is
   * a card) the camera stays where it is.
   *
   * @param ids One id or a list of ids.
   * @throws {CorkboardError} `'invalid'` for ids of the wrong type or a bad `padding` (not a finite number >= 0).
   */
  fit(ids?: CardId | readonly CardId[], o?: CameraMoveOptions): void;
  /**
   * Fits a world rectangle in the view.
   *
   * @throws {CorkboardError} `'invalid'` unless the four corners are finite numbers (and `padding` is >= 0).
   */
  zoomTo(r: Rect, o?: CameraMoveOptions): void;
  /**
   * Multiplies the zoom by `k` about the middle of the view (animated; clamped to the zoom range).
   *
   * @throws {CorkboardError} `'invalid'` unless `k` is a finite number > 0.
   */
  zoomBy(k: number): void;
  /** Zooms to 100 % about the middle of the view. */
  actual(): void;
  /**
   * Centres the view on a world point, optionally at a given zoom (default: the current one).
   *
   * @throws {CorkboardError} `'invalid'` unless `x` and `y` are finite and `scale`, when given, is finite and > 0.
   */
  center(x: number, y: number, scale?: number, o?: CameraMoveOptions): void;
  /**
   * Changes the zoom range (the `camera` option's `minScale` / `maxScale`). A camera outside the new range is
   * brought into it about the middle of the view.
   *
   * @throws {CorkboardError} `'invalid'` unless `0 < min <= max` and both are finite.
   */
  setRange(min: number, max: number): void;
  /** The world rectangle in view. */
  visible(): Rect;
  /** Converts host-local CSS px to world coordinates. Throws `'invalid'` for a non-finite number. */
  screenToWorld(x: number, y: number): { x: number; y: number };
  /** Converts world coordinates to host-local CSS px. Throws `'invalid'` for a non-finite number. */
  worldToScreen(x: number, y: number): { x: number; y: number };
}

/** Options of the arrange methods of {@link LayoutApi}. */
export interface ArrangeOptions {
  /**
   * Animate the move.
   * @default true; elements far from the viewport jump
   */
  animate?: boolean;
  /**
   * Duration of the animation, ms.
   * @default 320
   */
  duration?: number;
}

/** Options of `layout.tidy` and `layout.masonry`. */
export interface GridOptions extends ArrangeOptions {
  /** Space between cards, world px (default: a tenth of the card width, 12..48). */
  gap?: number;
  /** Number of columns (default: a roughly square block, at most 10). */
  columns?: number;
}

/** Options of `layout.masonry`. */
export interface MasonryOptions extends GridOptions {
  /** Width of every card, world px (default: the median width). */
  width?: number;
}

/**
 * Auto layout, `board.layout`. Every method takes the ids to arrange (one id or a list; default: all) and writes
 * the result to the store in one batch, right away (one `change` event with `source: 'api'`): the animation only
 * changes how the cards are drawn. Locked cards stay where they are.
 *
 * Every method throws a `CorkboardError` (`'invalid'`) before writing anything for ids of the wrong type, an
 * unknown `mode` / `axis`, or an option out of range: `gap` and `duration` must be finite numbers >= 0, `columns`
 * an integer >= 1, `width` a finite number > 0, `animate` a boolean.
 */
export interface LayoutApi {
  /**
   * Reorders the cards into a masonry grid in reading order (rows top to bottom, left to right). Cards take the
   * median width and keep their aspect; the block stays anchored at its current top-left.
   */
  tidy(ids?: CardId | readonly CardId[], opts?: GridOptions): void;
  /**
   * Packs the cards into columns in the order given (the store's draw order by default): each goes into the
   * shortest column. Unlike `tidy` nothing is reordered by position.
   */
  masonry(ids?: CardId | readonly CardId[], opts?: MasonryOptions): void;
  /** Aligns the cards' edges or centres to one line (see {@link AlignMode}); cards that would overlap slide along the other axis. */
  align(mode: AlignMode, ids?: CardId | readonly CardId[], opts?: ArrangeOptions): void;
  /** Equal gaps between the cards along an axis (three or more). */
  distribute(axis: 'x' | 'y', ids?: CardId | readonly CardId[], opts?: ArrangeOptions): void;
  /**
   * Every card takes the median width; aspect-locked cards scale their height along. A card that grew pushes its
   * neighbours away (the arrange gap), as with align and distribute.
   */
  equalWidth(ids?: CardId | readonly CardId[], opts?: ArrangeOptions): void;
}

/**
 * The live iframes of the embed cards, `board.embeds`. The counters (live, parked, culled, frozen...) are in
 * `board.stats().embeds`.
 */
export interface EmbedsApi {
  /** Ids of the cards that hold a mounted iframe now (active and parked). */
  readonly live: ReadonlySet<CardId>;
  /** The card in interact mode (`null`: none). */
  readonly interacting: CardId | null;
  /** What is known about a card's embed (`undefined`: not an embed card, or no such card). */
  info(id: CardId): Readonly<ResolvedEmbed> | undefined;
  /**
   * Changes the embed options at any time (live limits, `resolution`, the security options...); fields left
   * out keep their value. See {@link EmbedOptions} for which apply to frames already mounted.
   */
  setOptions(o: Partial<EmbedOptions>): void;
  /**
   * Interact mode on a card: makes it live (whatever its size) and gives it pointer events. A card the page refuses
   * to frame opens its URL in a new tab instead.
   *
   * @returns `false` when there is nothing to do.
   */
  interact(id: CardId): boolean;
  /** Leaves interact mode (does nothing when no card is in it). */
  exitInteract(): void;
}

/** Video playback, `board.video`. The counters are also in `board.stats().video`. */
export interface VideoApi {
  /** Ids of the cards whose video plays now. */
  readonly playing: ReadonlySet<CardId>;
  /**
   * How many clips the always-playing pool may run now: `video.maxPlaying`, lowered while the page runs slow
   * and raised back when it is smooth (compare with `playing.size`). Can be `Infinity`.
   */
  readonly budget: number;
  /** Whether {@link VideoApi.setPaused} paused the videos. */
  readonly paused: boolean;
  /** Pauses every video (a lightbox open over the canvas, say), or lets them play again. */
  setPaused(paused: boolean): void;
  /** Changes the video options at any time; fields left out keep their value. */
  setOptions(o: Partial<VideoOptions>): void;
}

/**
 * What a host may drive on the pointer, touch and keyboard layer, `board.interaction` (`null` when
 * `interaction: false`). Selection is `board.select()`, events are `board.on()`.
 */
export interface InteractionApi {
  /**
   * A hand tool the host can switch (a toolbar button, a key of its own): while on, a left-button drag pans the
   * canvas wherever it starts, over a card included, exactly as with Space held.
   */
  setPanMode(on: boolean): void;
  /**
   * Changes the interaction options; fields left out keep their value. A gesture that is running is never
   * altered: the change applies at once when none is, else from the next pointer down after it ends.
   */
  setOptions(o: Partial<InteractionOptions>): void;
}
