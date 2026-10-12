import { describe, expect, it } from 'vitest';
import {
  CAPTION_MIN_DEVICE_PX,
  LOD_DOWN,
  LOD_L0_MAX_DEVICE_PX,
  LOD_L1_MAX_DEVICE_PX,
  LOD_L2_MAX_DEVICE_PX,
  LOD_UP,
  captionVisible,
  fitLong,
  l2Bucket,
  l3Bucket,
  pickLevel,
} from '../../src/render/lod';

describe('pickLevel', () => {
  it('picks the level from the device-pixel long side when there is no history', () => {
    expect(pickLevel(10)).toBe(0);
    expect(pickLevel(LOD_L0_MAX_DEVICE_PX - 1)).toBe(0);
    expect(pickLevel(LOD_L0_MAX_DEVICE_PX)).toBe(1);
    expect(pickLevel(LOD_L1_MAX_DEVICE_PX - 1)).toBe(1);
    expect(pickLevel(LOD_L1_MAX_DEVICE_PX)).toBe(2);
    expect(pickLevel(LOD_L2_MAX_DEVICE_PX - 1)).toBe(2);
    expect(pickLevel(LOD_L2_MAX_DEVICE_PX)).toBe(3);
    expect(pickLevel(1400)).toBe(3);
  });

  it('keeps the previous level inside the hysteresis band (no flapping)', () => {
    const t = LOD_L1_MAX_DEVICE_PX;
    // Sitting on the L1 / L2 boundary: whichever level it had stays.
    for (const d of [t * LOD_DOWN + 1, t, t * LOD_UP - 1]) {
      expect(pickLevel(d, 1)).toBe(1);
      expect(pickLevel(d, 2)).toBe(2);
    }
    // Jittering around the boundary never changes a settled level.
    let level = pickLevel(t - 5);
    for (let i = 0; i < 100; i++) level = pickLevel(t + Math.sin(i) * 8, level);
    expect(level).toBe(1);
  });

  it('moves past the band edges', () => {
    const t = LOD_L1_MAX_DEVICE_PX;
    expect(pickLevel(t * LOD_UP + 1, 1)).toBe(2);
    expect(pickLevel(t * LOD_DOWN - 1, 2)).toBe(1);
    const t0 = LOD_L0_MAX_DEVICE_PX;
    expect(pickLevel(t0 * LOD_UP + 1, 0)).toBe(1);
    expect(pickLevel(t0 * LOD_DOWN - 1, 1)).toBe(0);
    const t2 = LOD_L2_MAX_DEVICE_PX;
    expect(pickLevel(t2 * LOD_UP + 1, 2)).toBe(3);
    expect(pickLevel(t2 * LOD_UP - 1, 2)).toBe(2);
    expect(pickLevel(t2 * LOD_DOWN - 1, 3)).toBe(2);
    expect(pickLevel(t2 * LOD_DOWN + 1, 3)).toBe(3);
  });

  it('can skip a level on a big jump (a zoom-to-fit from 400 %)', () => {
    expect(pickLevel(5, 2)).toBe(0);
    expect(pickLevel(601, 0)).toBe(3);
    expect(pickLevel(1500, 1)).toBe(3);
    expect(pickLevel(5, 3)).toBe(0);
  });
});

describe('l2Bucket / fitLong', () => {
  it('uses the smallest bucket that covers the on-screen size', () => {
    expect(l2Bucket(130)).toBe(256);
    expect(l2Bucket(256)).toBe(256);
    expect(l2Bucket(300)).toBe(512);
    expect(l2Bucket(480)).toBe(512);
  });

  it('picks the large bucket for close zoom', () => {
    expect(l3Bucket(600)).toBe(1024);
    expect(l3Bucket(1024)).toBe(1024);
    expect(l3Bucket(1200)).toBe(1600);
    expect(l3Bucket(3000)).toBe(1600);
  });

  it('fits a size in a box keeping the aspect', () => {
    expect(fitLong(480, 600, 128)).toEqual({ w: 102, h: 128 });
    expect(fitLong(160, 90, 128)).toEqual({ w: 128, h: 72 });
    expect(fitLong(10, 10, 128)).toEqual({ w: 128, h: 128 });
  });
});

describe('captionVisible', () => {
  it('draws a caption from the readable size up and drops it below, with a hysteresis band', () => {
    expect(captionVisible(CAPTION_MIN_DEVICE_PX, false)).toBe(true);
    expect(captionVisible(CAPTION_MIN_DEVICE_PX - 0.1, false)).toBe(false);
    // Already drawn: it stays until it is clearly too small.
    expect(captionVisible(CAPTION_MIN_DEVICE_PX - 0.1, true)).toBe(true);
    expect(captionVisible(CAPTION_MIN_DEVICE_PX * LOD_DOWN, true)).toBe(true);
    expect(captionVisible(CAPTION_MIN_DEVICE_PX * LOD_DOWN - 0.01, true)).toBe(false);
  });

  it('is never drawn at the zoom where hundreds of cards share the view', () => {
    // A 13 px caption at 10 % on a 2x screen is 2.6 device px.
    expect(captionVisible(13 * 0.1 * 2, false)).toBe(false);
    expect(captionVisible(13 * 0.1 * 2, true)).toBe(false);
  });
});
