// Public data model of a corkboard. Pure types and constants: no Pixi, no DOM.
//
// Coordinates are world px at zoom 1. `rot` is DEGREES clockwise about the element's centre.
// (Adding an element kind is one view in src/render/views/registry.ts plus, when it needs DOM, one overlay
// (src/overlay.ts) or a layer like the video and embed ones (src/video, src/embed).)

/** What a card shows: a picture, a video (a DOM `<video>` over its poster) or a live web page / HTML snippet. */
export type CardKind = 'image' | 'video' | 'embed';

/** The id of a card: a string, unique on the board. */
export type CardId = string;

/**
 * The virtual screen a live iframe is laid out at, then scaled onto the card.
 * - `'720p'`: the page is laid out with its short side at 720 CSS px (a 16:9 card is a 1280 x 720 page).
 * - `'1080p'`: the same at 1080 (1920 x 1080).
 * - a number: that short side, in CSS px.
 * - `'native'`: the card's world size (a 400 px card is a 400 px wide page: mobile layouts, big text).
 */
export type EmbedResolution = '720p' | '1080p' | 'native' | number;

/**
 * What an `embed` card shows live: a page (`url`) or a snippet of HTML (`html`), in a sandboxed iframe. Exactly
 * one of the two. The sandbox profile is derived from this and the provider at render time and is never stored.
 */
export type EmbedSource = (
  | { url: string; html?: undefined }
  | { html: string; url?: undefined }
) & {
  /** Shown on the generated tile and in the iframe's `title`. */
  title?: string;
  /** Overrides the board's `embeds.resolution` for this card. */
  resolution?: EmbedResolution;
};

/** Where a card's pixels come from. */
export interface CardMediaInput {
  /**
   * The picture: an image URL, or the poster of a video or an embed. Must be fetchable with CORS (the
   * decode worker reads it with `fetch`, then uploads it to WebGL). Required for `image` and `video`
   * cards. An `embed` card may leave it out: the embed layer fills it with a poster it resolves (a
   * provider thumbnail, the `resolve` option's, or a generated tile).
   */
  src?: string;
  /** The video file, for a `video` card. Played in a DOM `<video>` laid over the card. */
  video?: string;
  /** The content of an `embed` card. Makes the card an `embed` unless `kind` says otherwise. */
  embed?: EmbedSource;
  /**
   * Optional smaller / larger renditions of `src`. The texture pipeline picks the level that matches
   * the card's size on screen: `small` fills an atlas cell (~160 px long side), `medium` is the sharp
   * texture of a card at normal zoom (~480 px), `large` is for close zoom (~1600 px). A missing
   * rendition falls back to `src`, which the decode worker then downsamples itself.
   */
  sizes?: { small?: string; medium?: string; large?: string };
  /**
   * `aspect`: height / width of the picture (the inverse of CSS `aspect-ratio`). Optional: with no `h` on the
   * element it sizes the card; a card whose size is known never needs it.
   */
  aspect?: number;
  /**
   * ThumbHash (https://evanw.github.io/thumbhash/) of the picture, <= 25 bytes, as bytes or base64.
   * The blurred first paint of a card; without it the card shows a flat `color` until its picture lands.
   * The board stores it as base64 (see {@link CardMedia}), so a card and its `change` payloads are JSON-safe.
   */
  thumbhash?: Uint8Array | string;
  /** Flat placeholder colour, "#rrggbb". */
  color?: string;
}

/**
 * The `media` of a stored card: a {@link CardMediaInput} as the board keeps it. A copy of what was passed to
 * `add` / `update` (later changes to the caller's object do not reach the card), with the thumbhash always a
 * base64 string, so a card, a `change` payload and a snapshot are plain JSON.
 */
export interface CardMedia extends Omit<CardMediaInput, 'thumbhash'> {
  /** ThumbHash as base64 (a `Uint8Array` given to `add` / `update` is converted). */
  thumbhash?: string;
}

/** A card as the board holds it. Coordinates are world px at zoom 1. */
export interface Card {
  /** Unique on the board. */
  id: CardId;
  /** What the card shows. */
  kind: CardKind;
  /** Left edge, world px (before rotation). */
  x: number;
  /** Top edge, world px (before rotation). */
  y: number;
  /** Width, world px. */
  w: number;
  /** Height, world px. */
  h: number;
  /** Rotation, degrees clockwise about the card's centre. Data only: there is no rotate gesture. */
  rot: number;
  /** A locked card cannot be moved, resized or deleted from the canvas and stays put in auto layout. */
  locked: boolean;
  /** Where the pixels come from. */
  media: CardMedia;
  /** Corner radius, world px. */
  radius: number;
  /** Keep w:h when resized (default true for image and video). */
  aspectLocked: boolean;
  /** Free for the host: carried through unchanged (and into `getSnapshot()`, by reference). */
  data?: unknown;
}

/** A field of a card that can change (everything but the `id`). */
export type CardProp = Exclude<keyof Card, 'id'>;

/**
 * One card in a `change` event's `updated`: the card as it is after the change, as it was before it, and which
 * fields differ. Inside a `batch` the changes to a card fold into one entry from the first `prev` to the last
 * `el`, so a card that ends up as it started is not reported at all.
 */
export interface CardUpdate {
  /** The card now. */
  el: Card;
  /** The card as it was before the change (or the batch). */
  prev: Card;
  /**
   * The fields that differ between `prev` and `el`, compared per top-level field with `Object.is`: a `media`
   * that was replaced counts as changed even if its contents are equal (and `data` is compared by reference).
   * Never empty. A field that was cleared (`data` set to `undefined`) is listed too: read `el[prop]`.
   */
  props: readonly CardProp[];
}

/**
 * What `add` takes. Everything but `media` is optional: a card with no position is placed next to what is on
 * screen (an `x` or `y` it has is kept); a missing size is derived from `w` and the media's aspect (an embed's
 * default width is `DEFAULTS.embedWidth`).
 */
export interface CardInit {
  /** Default: a generated unique id. Must not be on the board already. */
  id?: CardId;
  /** Default: `'embed'` when `media.embed` is set, else `'video'` when `media.video` is, else `'image'`. */
  kind?: CardKind;
  /** Left edge, world px. Default: placed. */
  x?: number;
  /** Top edge, world px. Default: placed. */
  y?: number;
  /** Width, world px. Default: `DEFAULTS.cardWidth` (`DEFAULTS.embedWidth` for an embed). */
  w?: number;
  /** Height, world px. Default: `w` times the media's aspect. */
  h?: number;
  /**
   * Rotation, degrees clockwise.
   * @default 0
   */
  rot?: number;
  /**
   * @default false
   */
  locked?: boolean;
  /** Where the pixels come from. */
  media: CardMediaInput;
  /**
   * Corner radius, world px.
   * @default DEFAULTS.cardRadius
   */
  radius?: number;
  /**
   * Keep w:h when resized.
   * @default true
   */
  aspectLocked?: boolean;
  /** Free for the host: carried through unchanged. */
  data?: unknown;
}

/**
 * What `update` takes: any field of a card but `id`. `kind` changes with `media` unless given. A field left out
 * or set to `undefined` is left as it is - except `data`: an own `data` key set to `undefined` clears it.
 */
export type CardPatch = Partial<Omit<Card, 'id' | 'kind' | 'media'>> & {
  kind?: CardKind;
  media?: CardMediaInput;
};

/**
 * Who made a change: a pointer or keyboard gesture (`'user'`), a call on the board or on `board.layout`
 * (`'api'`), `loadSnapshot()` (`'load'`), `applyChange()` (`'apply'`, or `'undo'` when inverted), or the library
 * itself (`'system'`: an embed card resized to its content, say). A host may pass its own tag to
 * `batch(fn, { source })`, e.g. `'remote'` for edits it replays from a peer.
 *
 * `'system'`, `'undo'` and `'apply'` writes are not new user edits: skip them when recording history and do not
 * broadcast them.
 */
export type ChangeSource = 'user' | 'api' | 'load' | 'system' | 'apply' | 'undo' | (string & {});

/**
 * One card whose place in the draw order is part of a {@link Change}. `prevBelow` / `nextBelow` are the card
 * directly BELOW it (drawn just before it) before and after the change; `null` means the bottom of the order
 * (or, in `prevBelow`, that the card did not exist before).
 */
export interface OrderMove {
  /** The card. */
  id: CardId;
  /** The card directly below it before the change (`null`: it was at the bottom, or did not exist). */
  prevBelow: CardId | null;
  /** The card directly below it after the change (`null`: it is at the bottom, or it was removed). */
  nextBelow: CardId | null;
}

/**
 * The draw-order part of a {@link Change}, as anchors instead of whole id lists (so it is O(moved) to store and
 * to replay, and it survives a peer whose order differs elsewhere).
 *
 * `moved` is a minimal set of cards that, taken out and put back, turns the old order into the new one: each is
 * placed directly above its `nextBelow`, bottom first (an undo does the same with `prevBelow`). It holds the
 * cards outside the longest run of cards that kept their relative order; for `bringToFront` / `sendToBack` it is
 * just the ids given. A removed card is in it with its `prevBelow` (and `nextBelow: null`), so undoing a delete
 * restores its depth. A card that was only appended on top (the usual `add`) is not in it: replaying the change
 * on a board where the card is not there yet puts it on top.
 */
export interface OrderChange {
  /** The cards to place, bottom of the new order first. */
  moved: readonly OrderMove[];
}

/**
 * What one `change` event carries: the net difference between the board before and after a call, a gesture
 * commit, a `batch` or a `loadSnapshot`. Plain data: `JSON.stringify` of it (with `media.thumbhash` stored as
 * base64 and a JSON-safe `data`) is what a sync or an undo stack can keep and replay with
 * `board.applyChange` / {@link invertChange}. The elements are the board's own objects: do not mutate them.
 */
export interface Change {
  /** Who made it. */
  source: ChangeSource;
  /** Cards that are new. */
  added: readonly Card[];
  /** Cards that are gone, as they were. */
  removed: readonly Card[];
  /** Cards that changed. */
  updated: readonly CardUpdate[];
  /** Present when the draw order changed other than by cards appended on top. */
  order?: OrderChange;
}

/** The sizes cards take when `add` is given none, and the limits of a resize. World px; aspects are height / width. */
export const DEFAULTS = {
  /** Width of an image or video card. */
  cardWidth: 248,
  /** Height / width of an image card whose picture has no known aspect. */
  cardAspect: 1.25,
  /** Height / width of a video card with no known aspect. */
  videoAspect: 9 / 16,
  /** Height / width of an embed card whose provider has no shape of its own. */
  embedAspect: 9 / 16,
  /** Width of an embed card. */
  embedWidth: 400,
  /** Corner radius. */
  cardRadius: 8,
  /** Narrowest a resize gesture makes a card. */
  minCardW: 40,
  /** Widest a resize gesture makes a card. */
  maxCardW: 1600,
} as const;

/** Lowest default zoom of the camera (`camera.minScale` overrides it). */
export const MIN_SCALE = 0.05;
/** Highest default zoom of the camera (`camera.maxScale` overrides it). */
export const MAX_SCALE = 4;
