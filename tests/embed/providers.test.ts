import { describe, expect, it } from 'vitest';
import {
  isAllowlisted,
  normalizeEmbedUrl,
  parseEmbedUrl,
  parseTimestamp,
  providerOfIframeSrc,
  withAutoplay,
  withJsApi,
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
  it('does not upgrade http on an explicit port: a LAN or dev server has no TLS there', () => {
    expect(normalizeEmbedUrl('http://192.168.1.20:3000/app')).toBe('http://192.168.1.20:3000/app');
    expect(normalizeEmbedUrl('http://dev.example.com:8080/')).toBe('http://dev.example.com:8080/');
    // The default port is no port at all.
    expect(normalizeEmbedUrl('http://example.com:80/a')).toBe('https://example.com/a');
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
  it('embeds a playlist: videoseries is a path word, not a video id', () => {
    const p = parseEmbedUrl('https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG');
    expect(p?.provider).toBe('youtube');
    expect(p?.iframeSrc).toBe(
      'https://www.youtube-nocookie.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
    );
    // No video id, so no ytimg poster to ask for.
    expect(p?.posters).toEqual([]);
    expect(providerOfIframeSrc(p?.iframeSrc ?? '')).toBe('youtube');
  });
  it('embeds a live stream by channel', () => {
    const p = parseEmbedUrl('https://www.youtube.com/embed/live_stream?channel=UCSJ4gkVC6NrvII8umztf0Ow');
    expect(p?.provider).toBe('youtube');
    expect(p?.iframeSrc).toBe(
      'https://www.youtube-nocookie.com/embed/live_stream?channel=UCSJ4gkVC6NrvII8umztf0Ow',
    );
    expect(p?.posters).toEqual([]);
  });
  it('falls back to a generic page for a playlist or live embed without its id', () => {
    expect(parseEmbedUrl('https://www.youtube.com/embed/videoseries')?.provider).toBe('generic');
    expect(parseEmbedUrl('https://www.youtube.com/embed/videoseries?list=a%26b')?.provider).toBe('generic');
    expect(parseEmbedUrl('https://www.youtube.com/embed/live_stream')?.provider).toBe('generic');
  });
  it('keeps the playlist of a video watched inside one', () => {
    const p = parseEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc_123-x&t=42');
    expect(p?.iframeSrc).toBe(`${embed}?list=PLabc_123-x&start=42`);
    expect(p?.posters[0]).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg');
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
  it('embeds the video of a showcase, album or group URL, not the collection', () => {
    expect(parseEmbedUrl('https://vimeo.com/showcase/987/video/123')?.iframeSrc).toBe(
      'https://player.vimeo.com/video/123',
    );
    expect(parseEmbedUrl('https://vimeo.com/album/987/video/123/abcdef1234')?.iframeSrc).toBe(
      'https://player.vimeo.com/video/123?h=abcdef1234',
    );
    expect(parseEmbedUrl('https://vimeo.com/groups/name/videos/123')?.iframeSrc).toBe(
      'https://player.vimeo.com/video/123',
    );
  });
  it('is a generic page for a showcase, album or event without a video', () => {
    for (const u of [
      'https://vimeo.com/showcase/987',
      'https://vimeo.com/album/987',
      'https://vimeo.com/event/987',
      'https://vimeo.com/showcase/987/video',
    ]) {
      expect(parseEmbedUrl(u)?.provider, u).toBe('generic');
    }
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

describe('withAutoplay', () => {
  const q = (src: string) => new URL(src).searchParams;

  it('starts a YouTube video muted, inline and looping (loop needs playlist=<id>)', () => {
    const src = withAutoplay('youtube', 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ');
    const u = new URL(src);
    expect(u.origin + u.pathname).toBe('https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      autoplay: '1',
      mute: '1',
      playsinline: '1',
      loop: '1',
      playlist: 'aqz-KE-bpKQ',
    });
  });

  it('keeps a start time, and a list the URL already has instead of playlist=<id>', () => {
    const withStart = q(withAutoplay('youtube', 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?start=90'));
    expect(withStart.get('start')).toBe('90');
    expect(withStart.get('playlist')).toBe('aqz-KE-bpKQ');
    const withList = q(withAutoplay('youtube', 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?list=PLabc'));
    expect(withList.get('list')).toBe('PLabc');
    expect(withList.has('playlist')).toBe(false);
    expect(withList.get('autoplay')).toBe('1');
  });

  it('does not loop a live stream and needs no playlist for a playlist embed', () => {
    const live = q(withAutoplay('youtube', 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCx'));
    expect(live.get('autoplay')).toBe('1');
    expect(live.has('loop')).toBe(false);
    expect(live.has('playlist')).toBe(false);
    const series = q(withAutoplay('youtube', 'https://www.youtube-nocookie.com/embed/videoseries?list=PLabc'));
    expect(series.get('loop')).toBe('1');
    expect(series.has('playlist')).toBe(false);
  });

  it('starts a Vimeo video muted and looping, keeping the unlisted hash', () => {
    const plain = withAutoplay('vimeo', 'https://player.vimeo.com/video/76979871');
    expect(new URL(plain).origin + new URL(plain).pathname).toBe('https://player.vimeo.com/video/76979871');
    expect(Object.fromEntries(q(plain))).toEqual({ autoplay: '1', muted: '1', loop: '1' });
    const hashed = q(withAutoplay('vimeo', 'https://player.vimeo.com/video/76979871?h=abc123def4'));
    expect(hashed.get('h')).toBe('abc123def4');
    expect(hashed.get('autoplay')).toBe('1');
  });

  it('leaves every other provider and unparsable URLs alone', () => {
    const spotify = 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT';
    expect(withAutoplay('spotify', spotify)).toBe(spotify);
    expect(withAutoplay('generic', 'https://example.com/a')).toBe('https://example.com/a');
    expect(withAutoplay('youtube', 'not a url')).toBe('not a url');
  });
});

describe('withJsApi', () => {
  const yt = 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ';

  it('turns the YouTube player API on, with the page origin when it is http(s)', () => {
    const u = new URL(withJsApi('youtube', yt, 'https://app.test'));
    expect(u.origin + u.pathname).toBe(yt);
    expect(Object.fromEntries(u.searchParams)).toEqual({ enablejsapi: '1', origin: 'https://app.test' });
    expect(new URL(withJsApi('youtube', yt)).searchParams.has('origin')).toBe(false);
    expect(new URL(withJsApi('youtube', yt, 'null')).searchParams.has('origin')).toBe(false);
  });

  it('keeps what the URL has, and combines with autoplay in either order', () => {
    const a = new URL(withAutoplay('youtube', withJsApi('youtube', `${yt}?start=90`, 'https://app.test')));
    expect(a.searchParams.get('start')).toBe('90');
    expect(a.searchParams.get('enablejsapi')).toBe('1');
    expect(a.searchParams.get('autoplay')).toBe('1');
  });

  it('leaves every other provider alone', () => {
    const vimeo = 'https://player.vimeo.com/video/76979871';
    expect(withJsApi('vimeo', vimeo, 'https://app.test')).toBe(vimeo);
    expect(withJsApi('generic', 'https://example.com/a')).toBe('https://example.com/a');
    expect(withJsApi('youtube', 'not a url')).toBe('not a url');
  });
});
