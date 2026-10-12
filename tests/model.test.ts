import { describe, expect, it } from 'vitest';
import { aspectOf, createElement, kindOf, sizeOf } from '../src/model';
import { DEFAULTS } from '../src/types';

describe('model', () => {
  it('infers the kind from the media', () => {
    expect(kindOf({ media: { src: 'a.jpg' } })).toBe('image');
    expect(kindOf({ media: { src: 'a.jpg', video: 'a.mp4' } })).toBe('video');
    expect(kindOf({ kind: 'image', media: { src: 'a.jpg', video: 'a.mp4' } })).toBe('image');
  });

  it('derives the aspect from the media, then the kind default', () => {
    expect(aspectOf({ src: 'a', aspect: 2 }, 'image')).toBe(2);
    expect(aspectOf({ src: 'a' }, 'image')).toBe(DEFAULTS.cardAspect);
    expect(aspectOf({ src: 'a' }, 'video')).toBe(DEFAULTS.videoAspect);
  });

  it('completes a lone width or height with the aspect', () => {
    expect(sizeOf({ media: { src: 'a', aspect: 2 }, w: 100 }, 'image')).toEqual({ w: 100, h: 200 });
    expect(sizeOf({ media: { src: 'a', aspect: 2 }, h: 200 }, 'image')).toEqual({ w: 100, h: 200 });
    expect(sizeOf({ media: { src: 'a' }, w: 10, h: 30 }, 'image')).toEqual({ w: 10, h: 30 });
  });

  it('creates an element with defaults', () => {
    const el = createElement({ media: { src: 'a', aspect: 1 } }, 'x');
    expect(el).toMatchObject({
      id: 'x',
      kind: 'image',
      x: 0,
      y: 0,
      w: DEFAULTS.cardWidth,
      h: DEFAULTS.cardWidth,
      rot: 0,
      locked: false,
      aspectLocked: true,
      radius: DEFAULTS.cardRadius,
    });
  });
});
