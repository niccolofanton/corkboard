// Messages between the TextureManager and its decode workers.
import type { Level } from './lod';

export interface DecodeRequest {
  op: 'load';
  rid: number;
  level: Level;
  // L0: the ThumbHash bytes. L1 / L2: the rendition URL.
  hash?: Uint8Array;
  url?: string;
  // Longest side of the output bitmap, in texels (never upscaled past the source).
  maxLong: number;
  // Corner radius in WORLD px and the card's long side in world px: the worker turns them into
  // texels for the size it ends up with.
  radiusWorld: number;
  worldLong: number;
  // Bake in a software (CPU) canvas instead of a GPU-backed one. Default false.
  soft?: boolean;
  // CSS colour of the 1 px card hairline to bake in (omitted for L0).
  border?: string;
}

export interface CancelRequest {
  op: 'cancel';
  rid: number;
}

export type WorkerIn = DecodeRequest | CancelRequest;

export interface DecodeDone {
  op: 'done';
  rid: number;
  bitmap: ImageBitmap;
  w: number;
  h: number;
  // Compressed bytes fetched (0 for L0).
  fetched: number;
  decodeMs: number;
}

export interface DecodeFail {
  op: 'fail';
  rid: number;
  reason: string;
  aborted: boolean;
}

export type WorkerOut = DecodeDone | DecodeFail;
