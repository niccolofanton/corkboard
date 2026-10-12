// Level-of-detail choice for a media card.
//
//   L0  ThumbHash, decoded to <= 32 px (a shared 32 px atlas): first paint and tiny cards
//   L1  ~160 px rendition packed into 128 px atlas cells: cards under ~128 device px
//   L2  ~480 px rendition, an own texture at bucket 256 / 512: up to ~480 device px
//   L3  ~1600 px rendition, an own texture at bucket 1024 / 1600: close zoom, at most MAX_L3 cards at a time
//
// The level follows the card's long side in DEVICE pixels. A hysteresis band keeps a view parked
// on a boundary from flapping (and re-fetching): a card goes up past `T * UP` and down below
// `T * DOWN`; inside the band it keeps its previous level. Originals never reach the canvas.
export type Level = 0 | 1 | 2 | 3;

export const LOD_L0_MAX_DEVICE_PX = 24;
export const LOD_L1_MAX_DEVICE_PX = 128;
export const LOD_L2_MAX_DEVICE_PX = 480;
export const LOD_THRESHOLDS: readonly [number, number, number] = [
  LOD_L0_MAX_DEVICE_PX,
  LOD_L1_MAX_DEVICE_PX,
  LOD_L2_MAX_DEVICE_PX,
];
export const LOD_UP = 1.25;
export const LOD_DOWN = 0.8;
export const MAX_LEVEL: Level = 3;
// Large (1600 px) textures are ~10 MB each: only the cards nearest to the view centre get one.
export const MAX_L3 = 12;

export function pickLevel(
  deviceLongSide: number,
  prev: Level | null = null,
  thresholds: readonly number[] = LOD_THRESHOLDS,
): Level {
  const start =
    deviceLongSide < thresholds[0]
      ? 0
      : deviceLongSide < thresholds[1]
        ? 1
        : deviceLongSide < thresholds[2]
          ? 2
          : 3;
  let level: number = prev ?? start;
  // Up: past the upper edge of the band above the current level.
  while (level < MAX_LEVEL && deviceLongSide > thresholds[level] * LOD_UP) level++;
  // Down: below the lower edge of the band under the current level.
  while (level > 0 && deviceLongSide < thresholds[level - 1] * LOD_DOWN) level--;
  return level as Level;
}

// Own textures (L2, L3) are uploaded at the smallest bucket (long side) that covers the on-screen size.
export const L2_BUCKETS = [256, 512] as const;
export const L3_BUCKETS = [1024, 1600] as const;
export function l2Bucket(deviceLongSide: number): number {
  return deviceLongSide <= L2_BUCKETS[0] / 0.9 ? L2_BUCKETS[0] : L2_BUCKETS[1];
}
export function l3Bucket(deviceLongSide: number): number {
  return deviceLongSide <= L3_BUCKETS[0] / 0.9 ? L3_BUCKETS[0] : L3_BUCKETS[1];
}
export function ownBucket(level: 2 | 3, deviceLongSide: number): number {
  return level === 2 ? l2Bucket(deviceLongSide) : l3Bucket(deviceLongSide);
}

// Fits (w, h) inside a `long`-sided box keeping the aspect (never upscales past `long`).
export function fitLong(w: number, h: number, long: number): { w: number; h: number } {
  const k = long / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// A card's caption (store/caption.ts) is drawn only where it can be read: from CAPTION_MIN_DEVICE_PX of font
// size up, in device px like every threshold above. Under it the caption is simply not drawn (the card's box,
// and so the gap under its picture, stays): at that zoom a view holds hundreds of cards and a grey bar per card
// would cost more than it says. The same hysteresis band keeps a view parked on the edge from flapping.
export const CAPTION_MIN_DEVICE_PX = 7;
export function captionVisible(fontDevicePx: number, prev: boolean): boolean {
  return fontDevicePx >= (prev ? CAPTION_MIN_DEVICE_PX * LOD_DOWN : CAPTION_MIN_DEVICE_PX);
}
