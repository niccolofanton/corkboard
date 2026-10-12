import { describe, expect, it } from 'vitest';
import { baseResolved, canGoLive, mergeResolved, sameEmbed } from '../../src/embed/resolve';
import { hostHue, tileSpec, tileSize } from '../../src/embed/tile';

describe('baseResolved', () => {
  it('reads a YouTube URL', () => {
    const r = baseResolved({ url: 'https://youtu.be/dQw4w9WgXcQ' });
    expect(r).toMatchObject({
      kind: 'url',
      provider: 'youtube',
      label: 'YouTube',
      frameable: true,
      iframeSrc: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    });
    expect(canGoLive(r)).toBe(true);
  });
  it('treats a snippet as live-able with nothing to load', () => {
    const r = baseResolved({ html: '<b>x</b>' });
    expect(r).toMatchObject({ kind: 'html', iframeSrc: null, frameable: true });
    expect(canGoLive(r)).toBe(true);
  });
  it('makes a bookmark of a URL that is not a web URL', () => {
    const r = baseResolved({ url: 'javascript:alert(1)' });
    expect(r.iframeSrc).toBeNull();
    expect(canGoLive(r)).toBe(false);
  });
});

describe('mergeResolved', () => {
  const base = baseResolved({ url: 'https://github.com/' });
  it('takes the poster first, keeping the provider candidates after it', () => {
    const yt = baseResolved({ url: 'https://youtu.be/dQw4w9WgXcQ' });
    const r = mergeResolved(yt, { poster: 'https://cdn.example/p.jpg' });
    expect(r.posters[0]).toBe('https://cdn.example/p.jpg');
    expect(r.posters).toHaveLength(yt.posters.length + 1);
  });
  it('marks a page that cannot be framed', () => {
    const r = mergeResolved(base, { frameable: false });
    expect(r.frameable).toBe(false);
    expect(canGoLive(r)).toBe(false);
  });
  it('does not let a resolver say frameable for what the library refused', () => {
    const bad = baseResolved({ url: 'javascript:1' });
    expect(canGoLive(mergeResolved(bad, { frameable: true, iframeSrc: 'https://ok.test' }))).toBe(false);
  });
  it('takes a safe iframeSrc and ignores an unsafe one', () => {
    expect(mergeResolved(base, { iframeSrc: 'https://embed.github.test/x' }).iframeSrc).toBe(
      'https://embed.github.test/x',
    );
    expect(mergeResolved(base, { iframeSrc: 'javascript:alert(1)' }).iframeSrc).toBe('https://github.com/');
    expect(mergeResolved(base, { iframeSrc: 'data:text/html,x' }).iframeSrc).toBe('https://github.com/');
  });
  it('keeps the card\'s own title over the resolver\'s', () => {
    const t = baseResolved({ url: 'https://example.com/', title: 'Mine' });
    expect(mergeResolved(t, { title: 'Theirs' }).title).toBe('Mine');
    expect(mergeResolved(base, { title: 'Theirs' }).title).toBe('Theirs');
  });
  it('takes a sane aspect only', () => {
    expect(mergeResolved(base, { aspect: 0.5 }).aspect).toBe(0.5);
    expect(mergeResolved(base, { aspect: -1 }).aspect).toBeUndefined();
    expect(mergeResolved(base, { aspect: Number.NaN }).aspect).toBeUndefined();
  });
  it('leaves a snippet alone', () => {
    const s = baseResolved({ html: 'x' });
    expect(mergeResolved(s, { frameable: false, iframeSrc: 'https://x.test', poster: 'https://p.test/p.png' })).toBe(s);
  });
  it('ignores null / undefined', () => {
    expect(mergeResolved(base, null)).toBe(base);
    expect(mergeResolved(base, undefined)).toBe(base);
  });
});

describe('sameEmbed', () => {
  it('compares url, html and title', () => {
    expect(sameEmbed({ url: 'a' }, { url: 'a' })).toBe(true);
    expect(sameEmbed({ url: 'a' }, { url: 'b' })).toBe(false);
    expect(sameEmbed({ html: 'a' }, { html: 'a' })).toBe(true);
    expect(sameEmbed({ url: 'a' }, { html: 'a' })).toBe(false);
    expect(sameEmbed({ url: 'a', title: 'x' }, { url: 'a' })).toBe(false);
  });
});

describe('tile', () => {
  it('has a stable hue per host', () => {
    expect(hostHue('github.com')).toBe(hostHue('github.com'));
    expect(hostHue('github.com')).not.toBe(hostHue('wikipedia.org'));
    expect(hostHue('x')).toBeGreaterThanOrEqual(0);
    expect(hostHue('x')).toBeLessThan(360);
  });
  it('picks a glyph and a label', () => {
    expect(tileSpec(baseResolved({ url: 'https://youtu.be/dQw4w9WgXcQ' }))).toMatchObject({ glyph: 'play', label: 'YouTube' });
    expect(tileSpec(baseResolved({ url: 'https://en.wikipedia.org/wiki/Moodboard' }))).toMatchObject({
      glyph: 'globe',
      label: 'en.wikipedia.org',
      title: 'Moodboard',
    });
    expect(tileSpec(baseResolved({ html: 'x' }))).toMatchObject({ glyph: 'code', title: 'HTML snippet' });
    expect(tileSpec(baseResolved({ html: 'x', title: 'Counter' })).title).toBe('Counter');
  });
  it('shows a bookmark glyph for a page that cannot be framed', () => {
    const r = mergeResolved(baseResolved({ url: 'https://github.com/' }), { frameable: false });
    expect(tileSpec(r).glyph).toBe('link-off');
  });
  it('sizes the tile from the aspect, clamped', () => {
    expect(tileSize(0.5625)).toEqual({ w: 640, h: 360 });
    expect(tileSize(10).h).toBeLessThanOrEqual(1024);
    expect(tileSize(0.01).h).toBeGreaterThanOrEqual(120);
  });
});
