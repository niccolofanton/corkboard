// Turns what the host passes to `add` into stored elements.
import { thumbHashToApproximateAspectRatio } from 'thumbhash';
import { parseEmbedUrl } from './embed/providers';
import { DEFAULTS, type Card, type CardInit, type CardKind, type CardMedia, type CardMediaInput } from './types';

export function decodeBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const SIZES = ['small', 'medium', 'large'] as const;

// A copy of `m` that shares nothing with it, as the board stores it: only the known fields, the thumbhash as
// base64. `keep` filters the URLs (a snapshot leaves out a `blob:` one: it is dead after a reload).
export function copyMedia(
  m: CardMediaInput,
  keep: (url: string | undefined) => boolean = () => true,
): CardMedia {
  const out: CardMedia = {};
  if (m.src !== undefined && keep(m.src)) out.src = m.src;
  if (m.video !== undefined && keep(m.video)) out.video = m.video;
  if (m.aspect !== undefined) out.aspect = m.aspect;
  if (m.color !== undefined) out.color = m.color;
  if (m.embed !== undefined) out.embed = { ...m.embed };
  if (m.sizes) {
    const sizes: NonNullable<CardMediaInput['sizes']> = {};
    for (const k of SIZES) if (m.sizes[k] !== undefined && keep(m.sizes[k])) sizes[k] = m.sizes[k];
    if (Object.keys(sizes).length > 0) out.sizes = sizes;
  }
  if (m.thumbhash !== undefined) {
    out.thumbhash = typeof m.thumbhash === 'string' ? m.thumbhash : toBase64(m.thumbhash);
  }
  return out;
}

// height / width of the picture, from the media's `aspect`, else from its ThumbHash, else a default.
export function aspectOf(media: CardMediaInput, kind: CardKind): number {
  if (media.aspect !== undefined && Number.isFinite(media.aspect) && media.aspect > 0) {
    return media.aspect;
  }
  if (media.thumbhash !== undefined) {
    try {
      const bytes =
        typeof media.thumbhash === 'string' ? decodeBase64(media.thumbhash) : media.thumbhash;
      const r = thumbHashToApproximateAspectRatio(bytes);
      if (Number.isFinite(r) && r > 0) return 1 / r;
    } catch {
      // A malformed hash: fall through to the default.
    }
  }
  if (kind === 'embed') {
    // A known provider has a shape of its own (16:9 for a video, a strip for a Spotify track).
    const url = media.embed?.url;
    return (url !== undefined ? parseEmbedUrl(url)?.aspect : undefined) ?? DEFAULTS.embedAspect;
  }
  return kind === 'video' ? DEFAULTS.videoAspect : DEFAULTS.cardAspect;
}

export const kindOf = (init: Pick<CardInit, 'kind' | 'media'>): CardKind =>
  init.kind ?? (init.media.embed ? 'embed' : init.media.video ? 'video' : 'image');

// Size of a card: a given `w` and `h` win; a lone `w` or `h` is completed with the aspect.
export function sizeOf(init: CardInit, kind: CardKind): { w: number; h: number } {
  const aspect = aspectOf(init.media, kind);
  if (init.w !== undefined && init.h !== undefined) return { w: init.w, h: init.h };
  if (init.h !== undefined) return { w: init.h / aspect, h: init.h };
  const w = init.w ?? (kind === 'embed' ? DEFAULTS.embedWidth : DEFAULTS.cardWidth);
  return { w, h: Math.max(1, Math.round(w * aspect)) };
}

// `x` / `y` default to 0 here; `Corkboard.add` places cards that have none before it gets this far.
export function createElement(init: CardInit, id: string): Card {
  const kind = kindOf(init);
  const { w, h } = sizeOf(init, kind);
  return {
    id,
    kind,
    x: init.x ?? 0,
    y: init.y ?? 0,
    w,
    h,
    rot: init.rot ?? 0,
    locked: init.locked ?? false,
    media: copyMedia(init.media),
    radius: init.radius ?? DEFAULTS.cardRadius,
    aspectLocked: init.aspectLocked ?? true,
    data: init.data,
  };
}

let counter = 0;
export function newId(): string {
  counter++;
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `cb-${Date.now().toString(36)}-${counter.toString(36)}`;
}
