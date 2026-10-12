import { describe, expect, it } from 'vitest';
import {
  isAllowlisted,
  normalizeEmbedUrl,
  parseEmbedUrl,
  parseTimestamp,
  providerOfIframeSrc,
} from '../../src/embed/providers';

describe('normalizeEmbedUrl', () => {
  it('keeps https and upgrades http', () => {
    expect(normalizeEmbedUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(normalizeEmbedUrl('http://example.com/a')).toBe('https://example.com/a');
  });
  it('lets http through on localhost only', () => {
    expect(normalizeEmbedUrl('http://localhost:5173/x')).toBe('http://localhost:5173/x');
    expect(normalizeEmbedUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/');
  });
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'file:///etc/passwd',
    'blob:https://a.com/x',
    'ftp://example.com',
    'not a url',
    '',
    'https://user:pw@example.com/',
  ])('refuses %s', (u) => {
    expect(normalizeEmbedUrl(u)).toBeNull();
  });
  it('trims', () => {
    expect(normalizeEmbedUrl('  https://example.com/  ')).toBe('https://example.com/');
  });
});

describe('parseTimestamp', () => {
  it.each([
    ['90', 90],
    ['90s', 90],
    ['1m30s', 90],
    ['1h2m3s', 3723],
    ['2m', 120],
  ])('%s', (t, s) => expect(parseTimestamp(t)).toBe(s));
  it.each(['', 'abc', null, 'm', '1x'])('refuses %s', (t) => expect(parseTimestamp(t)).toBeNull());
});

describe('YouTube', () => {
  const embed = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ])('%s', (u) => {
    const p = parseEmbedUrl(u);
    expect(p?.provider).toBe('youtube');
    expect(p?.iframeSrc).toBe(embed);
    expect(p?.aspect).toBeCloseTo(9 / 16);
    expect(p?.posters[0]).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg');
    expect(p?.posters).toContain('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  });
  it('carries the start time', () => {
    expect(parseEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=1m30s')?.iframeSrc).toBe(`${embed}?start=90`);
    expect(parseEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42')?.iframeSrc).toBe(
      `${embed}?start=42`,
    );
  });
  it('falls back to a generic page when there is no valid id', () => {
    expect(parseEmbedUrl('https://www.youtube.com/watch?v=short')?.provider).toBe('generic');
    expect(parseEmbedUrl('https://www.youtube.com/')?.provider).toBe('generic');
  });
});

describe('Vimeo', () => {
  it.each([
    'https://vimeo.com/76979871',
    'https://player.vimeo.com/video/76979871',
    'https://vimeo.com/channels/staffpicks/76979871',
  ])('%s', (u) => {
    const p = parseEmbedUrl(u);
    expect(p?.provider).toBe('vimeo');
    expect(p?.iframeSrc).toBe('https://player.vimeo.com/video/76979871');
  });
  it('keeps the unlisted hash', () => {
    expect(parseEmbedUrl('https://vimeo.com/76979871/abcdef1234')?.iframeSrc).toBe(
      'https://player.vimeo.com/video/76979871?h=abcdef1234',
    );
    expect(parseEmbedUrl('https://player.vimeo.com/video/76979871?h=abc12345')?.iframeSrc).toBe(
      'https://player.vimeo.com/video/76979871?h=abc12345',
    );
  });
  it('needs a numeric id', () => {
    expect(parseEmbedUrl('https://vimeo.com/about')?.provider).toBe('generic');
  });
});

describe('Spotify', () => {
  const id = '4cOdK2wGLETKBW3PvgPWqT';
  it.each([
    `https://open.spotify.com/track/${id}`,
    `https://open.spotify.com/track/${id}?si=xyz`,
    `https://open.spotify.com/intl-it/track/${id}`,
    `https://open.spotify.com/embed/track/${id}`,
  ])('%s', (u) => {
    const p = parseEmbedUrl(u);
    expect(p?.provider).toBe('spotify');
    expect(p?.iframeSrc).toBe(`https://open.spotify.com/embed/track/${id}`);
  });
  it('is a strip for a track and taller for an album', () => {
    const track = parseEmbedUrl(`https://open.spotify.com/track/${id}`)?.aspect ?? 0;
    const album = parseEmbedUrl(`https://open.spotify.com/album/${id}`)?.aspect ?? 0;
    expect(track).toBeLessThan(album);
  });
  it('refuses an unknown type or a bad id', () => {
    expect(parseEmbedUrl(`https://open.spotify.com/user/${id}`)?.provider).toBe('generic');
    expect(parseEmbedUrl('https://open.spotify.com/track/short')?.provider).toBe('generic');
  });
});

describe('CodePen', () => {
  it.each([
    'https://codepen.io/chriscoyier/pen/gfdDu',
    'https://codepen.io/chriscoyier/full/gfdDu',
    'https://codepen.io/chriscoyier/embed/gfdDu',
  ])('%s', (u) => {
    const p = parseEmbedUrl(u);
    expect(p?.provider).toBe('codepen');
    expect(p?.iframeSrc).toBe('https://codepen.io/chriscoyier/embed/gfdDu?default-tab=result');
  });
  it('handles team pens', () => {
    expect(parseEmbedUrl('https://codepen.io/team/codepen/pen/PNaGbb')?.iframeSrc).toBe(
      'https://codepen.io/team/codepen/embed/PNaGbb?default-tab=result',
    );
  });
  it('is generic for a profile page', () => {
    expect(parseEmbedUrl('https://codepen.io/chriscoyier')?.provider).toBe('generic');
  });
});

describe('Figma', () => {
  it('wraps the file URL in the embed host', () => {
    const u = 'https://www.figma.com/design/abc123/My-File?node-id=1-2';
    const p = parseEmbedUrl(u);
    expect(p?.provider).toBe('figma');
    expect(p?.iframeSrc).toBe(
      `https://www.figma.com/embed?embed_host=corkboard&url=${encodeURIComponent(u)}`,
    );
  });
  it('is generic for the marketing site', () => {
    expect(parseEmbedUrl('https://www.figma.com/pricing')?.provider).toBe('generic');
  });
});

describe('generic', () => {
  it('loads the page as it is', () => {
    const p = parseEmbedUrl('https://en.wikipedia.org/wiki/Moodboard');
    expect(p).toMatchObject({
      provider: 'generic',
      host: 'en.wikipedia.org',
      iframeSrc: 'https://en.wikipedia.org/wiki/Moodboard',
      posters: [],
    });
    expect(p?.aspect).toBeUndefined();
  });
  it('strips www from the host', () => {
    expect(parseEmbedUrl('https://www.example.com/')?.host).toBe('example.com');
  });
  it('is null for something that is not a web URL', () => {
    expect(parseEmbedUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('vimeo hash', () => {
  it('keeps only a hex `h` and builds the query itself', () => {
    expect(parseEmbedUrl('https://player.vimeo.com/video/76979871?h=abc12345&autoplay=1')?.iframeSrc).toBe(
      'https://player.vimeo.com/video/76979871?h=abc12345',
    );
    const bad = parseEmbedUrl('https://player.vimeo.com/video/76979871?h=a%26autoplay%3D1%23x');
    expect(bad?.iframeSrc).toBe('https://player.vimeo.com/video/76979871');
    expect(parseEmbedUrl('https://vimeo.com/76979871?h=zz9')?.iframeSrc).toBe('https://player.vimeo.com/video/76979871');
  });
});

describe('providerOfIframeSrc', () => {
  it('allowlists exactly the embed URLs the parsers emit, for every provider', () => {
    for (const u of [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://vimeo.com/76979871/abcdef1234',
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://codepen.io/team/acme/pen/AbCdEf',
      'https://codepen.io/user/pen/AbCdEf',
      'https://www.figma.com/design/abc/Name',
    ]) {
      const p = parseEmbedUrl(u);
      expect(p && providerOfIframeSrc(p.iframeSrc), u).toBe(p?.provider);
      expect(p?.provider).not.toBe('generic');
    }
  });
  it('does not give the sandbox of a provider to its other pages', () => {
    for (const u of [
      'https://www.youtube.com/redirect?q=https://evil.example',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/redirect?q=x',
      'https://player.vimeo.com/api/x',
      'https://open.spotify.com/user/x',
      'https://codepen.io/user/pen/AbCdEf',
      'https://www.figma.com/file/abc',
      'http://player.vimeo.com/video/1',
    ]) {
      expect(providerOfIframeSrc(u), u).toBe('generic');
    }
  });
  it('goes by the serving host, not by the query', () => {
    expect(providerOfIframeSrc('https://www.youtube-nocookie.com/embed/x')).toBe('youtube');
    expect(providerOfIframeSrc('https://player.vimeo.com/video/1')).toBe('vimeo');
    expect(providerOfIframeSrc('https://evil.example/?u=https://www.youtube.com/')).toBe('generic');
    expect(providerOfIframeSrc('https://www.youtube.com.evil.example/embed/x')).toBe('generic');
    expect(providerOfIframeSrc('nonsense')).toBe('generic');
  });
  it('allowlists every provider but generic', () => {
    expect(isAllowlisted('youtube')).toBe(true);
    expect(isAllowlisted('generic')).toBe(false);
  });
});
