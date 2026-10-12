import { describe, expect, it } from 'vitest';
import { aspectOf, createElement, kindOf, sizeOf } from '../src/model';
import { DEFAULTS } from '../src/types';

describe('model', () => {
  it('infers the kind from the media', () => {
    expect(kindOf({ media: { src: 'a.jpg' } })).toBe('image');
    expect(kindOf({ media: { src: 'a.jpg', video: 'a.mp4' } })).toBe('video');
    expect(kindOf({ kind: 'image', media: { src: 'a.jpg', video: 'a.mp4' } })).toBe('image');
  });

  it('makes an embed of media that holds one', () => {
    expect(kindOf({ media: { embed: { url: 'https://example.com' } } })).toBe('embed');
    expect(kindOf({ media: { embed: { html: '<b>x</b>' } } })).toBe('embed');
    expect(kindOf({ kind: 'image', media: { src: 'a.jpg', embed: { url: 'https://example.com' } } })).toBe('image');
  });

  it('gives an embed the shape of its provider, else the embed default', () => {
    const yt = { embed: { url: 'https://youtu.be/dQw4w9WgXcQ' } };
    expect(aspectOf(yt, 'embed')).toBeCloseTo(9 / 16);
    expect(aspectOf({ embed: { url: 'https://example.com' } }, 'embed')).toBe(DEFAULTS.embedAspect);
    expect(aspectOf({ embed: { html: 'x' } }, 'embed')).toBe(DEFAULTS.embedAspect);
    expect(aspectOf({ ...yt, aspect: 2 }, 'embed')).toBe(2);
  });

  it('sizes an embed from its own default width', () => {
    const el = createElement({ media: { embed: { url: 'https://youtu.be/dQw4w9WgXcQ' } } }, 'e');
    expect(el.kind).toBe('embed');
    expect(el.w).toBe(DEFAULTS.embedWidth);
    expect(el.h).toBe(Math.round(DEFAULTS.embedWidth * (9 / 16)));
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
