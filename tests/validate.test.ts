import { describe, expect, it } from 'vitest';
import { CorkboardError } from '../src/errors';
import { decodeBase64 } from '../src/model';
import { validateInits, validatePatch } from '../src/validate';
import type { CardInit } from '../src/types';

const ok: CardInit = { id: 'a', x: 1, y: 2, w: 10, h: 10, media: { src: 'a.jpg' } };
const none = () => false;

function invalid(fn: () => void, match: RegExp): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CorkboardError);
  expect((err as CorkboardError).code).toBe('invalid');
  expect((err as CorkboardError).message).toMatch(match);
}

describe('validateInits', () => {
  it('accepts a plain batch, defaults included', () => {
    expect(() =>
      validateInits(
        [ok, { media: { src: 'b.jpg' } }, { media: { embed: { url: 'https://example.com' } }, radius: 0, rot: -45 }],
        none,
      ),
    ).not.toThrow();
  });

  it('names the item and the field', () => {
    invalid(() => validateInits([ok, { ...ok, id: 'b', x: NaN }], none), /item 1 \("b"\).*x/);
    invalid(() => validateInits([{ media: { src: 'a' }, y: Infinity }], none), /item 0.*y/);
    invalid(() => validateInits([{ ...ok, rot: NaN }], none), /rot/);
  });

  it('wants a size above zero, a radius from zero and an aspect above zero', () => {
    invalid(() => validateInits([{ ...ok, w: 0 }], none), /w must be/);
    invalid(() => validateInits([{ ...ok, h: -1 }], none), /h must be/);
    invalid(() => validateInits([{ ...ok, w: Infinity }], none), /w must be/);
    invalid(() => validateInits([{ ...ok, radius: -1 }], none), /radius/);
    invalid(() => validateInits([{ ...ok, media: { src: 'a', aspect: 0 } }], none), /aspect/);
    invalid(() => validateInits([{ ...ok, media: { src: 'a', aspect: NaN } }], none), /aspect/);
  });

  it('rejects a missing or non-object media, and a bad id', () => {
    invalid(() => validateInits([{} as CardInit], none), /media/);
    invalid(() => validateInits([{ media: 'a.jpg' } as unknown as CardInit], none), /media/);
    invalid(() => validateInits([{ ...ok, id: '' }], none), /id/);
    invalid(() => validateInits([{ ...ok, id: 3 as unknown as string }], none), /id/);
  });

  it('rejects an id used twice in the batch or already on the board', () => {
    invalid(() => validateInits([ok, { ...ok }], none), /item 1.*duplicate/);
    invalid(() => validateInits([ok], (id) => id === 'a'), /already exists/);
  });

  it('wants exactly one of url / html, non-empty', () => {
    const embed = (e: object) => [{ media: { embed: e } } as unknown as CardInit];
    invalid(() => validateInits(embed({ url: 'https://x.test', html: '<p>' }), none), /exactly one/);
    invalid(() => validateInits(embed({ title: 'none' }), none), /exactly one/);
    invalid(() => validateInits(embed({ url: '' }), none), /url/);
    invalid(() => validateInits(embed({ html: '' }), none), /html/);
    invalid(() => validateInits(embed({ url: 5 }), none), /url/);
    expect(() => validateInits(embed({ html: '<p>x</p>' }), none)).not.toThrow();
  });
});

describe('validatePatch', () => {
  it('accepts a partial patch and ignores fields left undefined', () => {
    expect(() => validatePatch('a', { x: 5, w: undefined, data: null, locked: true })).not.toThrow();
    expect(() => validatePatch('a', {})).not.toThrow();
  });

  it('applies the numeric rules of add to the fields it carries', () => {
    invalid(() => validatePatch('a', { x: NaN }), /update \("a"\).*x/);
    invalid(() => validatePatch('a', { w: 0 }), /w must be/);
    invalid(() => validatePatch('a', { h: -3 }), /h must be/);
    invalid(() => validatePatch('a', { rot: Infinity }), /rot/);
    invalid(() => validatePatch('a', { radius: -1 }), /radius/);
  });

  it('checks a new media', () => {
    invalid(() => validatePatch('a', { media: { src: 'a', aspect: -1 } }), /aspect/);
    invalid(() => validatePatch('a', { media: { embed: { url: 'u', html: 'h' } } as never }), /exactly one/);
    expect(() => validatePatch('a', { media: { src: 'b.jpg' } })).not.toThrow();
  });
});

describe('media.thumbhash', () => {
  const accepted = (v: string): boolean => {
    try {
      validatePatch('a', { media: { src: 'a.jpg', thumbhash: v } });
      return true;
    } catch {
      return false;
    }
  };

  it('rejects padding that is not a multiple of 4 long', () => {
    for (const v of ['AA=', 'AAA==', 'AAAA=', 'AAAA==', 'A=', 'AAAAAA=', 'AAAAAAA==', 'A===', '', '=', 'AAAAA', 'A']) {
      expect(accepted(v), JSON.stringify(v)).toBe(false);
    }
  });

  it('accepts padded, unpadded and url-safe base64', () => {
    for (const v of ['AA==', 'AAA=', 'AAAA', 'AA', 'AAA', 'AAAAAA==', 'AAAAAAA=', 'ab-_', 'ab+/', 'ab-_cd']) {
      expect(accepted(v), JSON.stringify(v)).toBe(true);
    }
  });

  it('everything it accepts decodes with the decoder the board uses', () => {
    const alphabet = ['A', '-', '/', '='];
    let n = 0;
    const walk = (s: string, left: number): void => {
      if (s !== '' && accepted(s)) {
        n++;
        expect(() => decodeBase64(s), JSON.stringify(s)).not.toThrow();
      }
      if (left === 0) return;
      for (const c of alphabet) walk(s + c, left - 1);
    };
    walk('', 8);
    expect(n).toBeGreaterThan(1000);
  });
});
