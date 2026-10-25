// A board as plain JSON: `getSnapshot()` writes one, `loadSnapshot()` reads one (src/Corkboard.ts). Pure: no
// Pixi, no DOM.
//
// A snapshot never shares an object with the store: `media` (the only nested value the board owns) is copied on
// the way out and on the way in. `data` is the host's and passes by reference.
import { deepEqual } from './equal';
import { CorkboardError } from './errors';
import type { Camera } from './math';
import { copyMedia, kindOf } from './model';
import { DEFAULTS, type Card, type CardId, type CardKind, type CardMedia, type CardMediaInput } from './types';
import { validateSnapshotElement } from './validate';

/**
 * The version of the snapshot format this build writes, and the newest it reads. It goes up whenever a field
 * is added to, or changes meaning in, what a snapshot persists (the card fields, `media`, the camera): an older
 * build then refuses the file instead of dropping the field. `data` is the extension slot - put what you need
 * to persist there and the version does not change.
 */
export const SNAPSHOT_VERSION = 1;

/** A card as a snapshot holds it: a `Card` (its `media.thumbhash` is a base64 string). */
export type SnapshotCard = Card;

/**
 * A card as `loadSnapshot` reads it: the `id`, the position and size and the `media` are required, every other
 * field takes the default `add` gives it (`kind` comes from `media`). A `getSnapshot()` card fits.
 */
export type SnapshotCardInput = Pick<Card, 'id' | 'x' | 'y' | 'w' | 'h'> &
  Partial<Omit<Card, 'id' | 'x' | 'y' | 'w' | 'h' | 'media'>> & { media: CardMediaInput };

/** What `loadSnapshot` takes: a {@link BoardSnapshot}, or one written by hand with only the required card fields. */
export interface BoardSnapshotInput {
  /** Must be `'corkboard'`. */
  format: 'corkboard';
  /** Format version; a newer one than this build reads is refused. */
  version: number;
  /** The cards, bottom of the draw order first. */
  elements: readonly SnapshotCardInput[];
  /** The view to jump to. */
  camera?: Camera;
}

/**
 * The persistent part of a board: its cards, bottom of the draw order first, and the camera. Selection,
 * theme, settings and runtime state (posters, snapshots, resolved embed posters) are not in it.
 */
export interface BoardSnapshot {
  /** Marks the object as a corkboard snapshot. */
  format: 'corkboard';
  /** Format version, {@link SNAPSHOT_VERSION}. `loadSnapshot()` refuses a newer one. */
  version: typeof SNAPSHOT_VERSION;
  /** Draw order, bottom first. */
  elements: SnapshotCard[];
  /** The view when it was taken. Absent with `getSnapshot({ camera: false })`. */
  camera?: Camera;
}

export const SNAPSHOT_FORMAT = 'corkboard';

const isBlob = (u: string | undefined): boolean => u !== undefined && u.startsWith('blob:');

// Whether two medias hold the same values (`loadSnapshot` keeps the store's media object for a card that
// did not change, so the card does not show up in the `change` event).
const sameMedia = (a: CardMedia, b: CardMedia): boolean => deepEqual(a, b);

// A `blob:` URL dies with the page that made it: after a reload it points at nothing, so it is left out
// (the card then shows its placeholder until the host sets a durable URL with `update`).
const mediaToJSON = (m: CardMedia): CardMedia => copyMedia(m, (u) => !isBlob(u));

export function elementToJSON(el: Card): SnapshotCard {
  const out: SnapshotCard = {
    id: el.id,
    kind: el.kind,
    x: el.x,
    y: el.y,
    w: el.w,
    h: el.h,
    rot: el.rot,
    locked: el.locked,
    media: mediaToJSON(el.media),
    radius: el.radius,
    aspectLocked: el.aspectLocked,
  };
  // JSON drops an undefined `data` anyway; keep the object free of the key so deep-equality on it is exact.
  if (el.data !== undefined) out.data = el.data;
  return out;
}

export function toSnapshot(elements: readonly Card[], camera: Camera | undefined): BoardSnapshot {
  const s: BoardSnapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    elements: elements.map(elementToJSON),
  };
  if (camera) s.camera = { scale: camera.scale, tx: camera.tx, ty: camera.ty };
  return s;
}

const invalid = (what: string): never => {
  throw new CorkboardError('invalid', `loadSnapshot: ${what}`);
};

// Checks the whole snapshot, then builds the elements; throws a `CorkboardError('invalid')` before any of
// it is used. Fields a hand-written snapshot may leave out (all but id, x, y, w, h and media) take the same
// defaults as `add`; keys it has that a card does not are dropped. `existing` looks up the cards on the board now.
export function fromSnapshot(
  s: unknown,
  existing: (id: CardId) => Card | undefined = () => undefined,
): { elements: Card[]; camera?: Camera } {
  if (typeof s !== 'object' || s === null) return invalid('snapshot must be an object');
  const o = s as Record<string, unknown>;
  if (o.format !== SNAPSHOT_FORMAT) invalid(`format must be "${SNAPSHOT_FORMAT}" (got ${JSON.stringify(o.format)})`);
  const v = o.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    invalid(`version must be a positive integer (got ${JSON.stringify(v)})`);
  }
  if ((v as number) > SNAPSHOT_VERSION) {
    invalid(
      `snapshot written by a newer corkboard (v${v}); this build reads up to v${SNAPSHOT_VERSION}`,
    );
  }
  if (!Array.isArray(o.elements)) return invalid('elements must be an array');
  let camera: Camera | undefined;
  if (o.camera !== undefined) {
    const c = o.camera as Partial<Camera> | null;
    const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
    if (typeof c !== 'object' || c === null || !num(c.scale) || !num(c.tx) || !num(c.ty) || (c.scale as number) <= 0) {
      invalid('camera must be { scale > 0, tx, ty } with finite numbers');
    }
    const cam = c as Camera;
    camera = { scale: cam.scale, tx: cam.tx, ty: cam.ty };
  }
  const seen = new Set<CardId>();
  o.elements.forEach((el, i) => validateSnapshotElement(i, el, seen));
  const elements = (o.elements as SnapshotCardInput[]).map((e): Card => {
    const copy = copyMedia(e.media);
    const prev = existing(e.id);
    const kind: CardKind = e.kind ?? kindOf({ media: copy });
    return {
      id: e.id,
      kind,
      x: e.x,
      y: e.y,
      w: e.w,
      h: e.h,
      rot: e.rot ?? 0,
      locked: e.locked ?? false,
      media: prev && sameMedia(prev.media, copy) ? prev.media : copy,
      radius: e.radius ?? DEFAULTS.cardRadius,
      aspectLocked: e.aspectLocked ?? true,
      // A `data` equal to the board's keeps the board's object: no phantom update, as with `media`.
      data: prev && deepEqual(prev.data, e.data) ? prev.data : e.data,
    };
  });
  return camera ? { elements, camera } : { elements };
}
