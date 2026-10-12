// Public data model of a corkboard. Pure types and constants: no Pixi, no DOM.
//
// Coordinates are world px at zoom 1. `rot` is DEGREES clockwise about the element's centre.

// Element kinds. Adding a kind (an `embed` card holding an iframe or HTML, say) is one view
// (src/render/views/registry.ts) plus, when it needs DOM, one overlay (src/overlay.ts).
export type ElementKind = 'image' | 'video';

export type ElementId = string;

// Where a card's pixels come from.
export interface MediaSource {
  // The picture: an image URL, or the poster of a video. Must be fetchable with CORS (the decode worker
  // reads it with `fetch`, then uploads it to WebGL).
  src: string;
  // The video file, for a `video` card. Played in a DOM <video> laid over the card (src/video/*).
  video?: string;
  // Optional smaller / larger renditions of `src`. The texture pipeline picks the level that matches
  // the card's size on screen: `small` fills an atlas cell (~160 px long side), `medium` is the sharp
  // texture of a card at normal zoom (~480 px), `large` is for close zoom (~1600 px). A missing
  // rendition falls back to `src`, which the decode worker then downsamples itself.
  sizes?: { small?: string; medium?: string; large?: string };
  // height / width of the picture. Optional: with no `h` on the element it sizes the card; a card
  // whose size is known never needs it.
  aspect?: number;
  // ThumbHash (https://evanw.github.io/thumbhash/) of the picture, <= 25 bytes, as bytes or base64.
  // The blurred first paint of a card; without it the card shows a flat `color` until its picture lands.
  thumbhash?: Uint8Array | string;
  // Flat placeholder colour, "#rrggbb".
  color?: string;
}

// A card as the store holds it.
export interface Element {
  id: ElementId;
  kind: ElementKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  locked: boolean;
  media: MediaSource;
  // Corner radius, world px.
  radius: number;
  // Keep w:h when resized (default true for image and video).
  aspectLocked: boolean;
  // Free for the host: carried through unchanged.
  data?: unknown;
}

// What `add` takes. Everything but `media` is optional: a card with no position is placed by
// `autoSpot` next to what is on screen; a missing size is derived from `w` and the media's aspect.
export interface ElementInit {
  id?: ElementId;
  kind?: ElementKind;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rot?: number;
  locked?: boolean;
  media: MediaSource;
  radius?: number;
  aspectLocked?: boolean;
  data?: unknown;
}

// What `update` takes.
export type ElementPatch = Partial<Omit<Element, 'id' | 'kind'>> & { kind?: ElementKind };

export const DEFAULTS = {
  cardWidth: 248,
  cardAspect: 1.25,
  videoAspect: 9 / 16,
  cardRadius: 8,
  minCardW: 40,
  maxCardW: 1600,
} as const;

// Zoom range of the camera.
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 4;
