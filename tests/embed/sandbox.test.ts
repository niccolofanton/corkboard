import { describe, expect, it, vi } from 'vitest';
import { EMBED_CB, SNIPPET_BOOTSTRAP } from '../../src/embed/bootstrap';
import { CorkboardError } from '../../src/errors';
import {
  hostIsolated,
  iframeSpecFor,
  normalizeIsolatedHost,
  normalizeIsolatedHosts,
  SNIPPET_CSP_NONE,
  snippetCsp,
  SANDBOX_ARBITRARY,
  SANDBOX_PROVIDER,
  SANDBOX_SNIPPET,
  SNIPPET_CSP,
  snippetDocument,
} from '../../src/embed/sandbox';

const FORBIDDEN = [
  'allow-top-navigation',
  'allow-modals',
  'allow-pointer-lock',
  'allow-downloads',
  'allow-popups-to-escape-sandbox',
];

describe('iframeSpecFor', () => {
  it('gives an allowlisted provider the provider profile', () => {
    const s = iframeSpecFor({
      source: { url: 'https://youtu.be/dQw4w9WgXcQ' },
      iframeSrc: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    });
    expect(s).toMatchObject({
      profile: 'provider',
      provider: 'youtube',
      sandbox: SANDBOX_PROVIDER,
      src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      referrerPolicy: 'strict-origin-when-cross-origin',
      loading: 'lazy',
    });
    expect(s?.allow).toBe('autoplay; encrypted-media; fullscreen; picture-in-picture');
  });

  it('gives an arbitrary URL the profile without presentation and an empty allow list', () => {
    const s = iframeSpecFor({ source: { url: 'https://en.wikipedia.org/wiki/Moodboard' } });
    expect(s).toMatchObject({ profile: 'arbitrary', sandbox: SANDBOX_ARBITRARY, allow: '' });
    expect(s?.sandbox).not.toContain('allow-presentation');
    expect(s?.sandbox).toContain('allow-same-origin');
  });

  it('judges by the host that serves the iframe, not by what the card says', () => {
    const s = iframeSpecFor({
      source: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      iframeSrc: 'https://evil.example/embed/dQw4w9WgXcQ',
    });
    expect(s?.profile).toBe('arbitrary');
    expect(s?.allow).toBe('');
  });

  it('runs a snippet in a sandbox with scripts only', () => {
    const s = iframeSpecFor({ source: { html: '<p>hi</p>' } });
    expect(s?.profile).toBe('snippet');
    expect(s?.sandbox).toBe(SANDBOX_SNIPPET);
    expect(s?.sandbox).toBe('allow-scripts');
    expect(s?.src).toBeUndefined();
    expect(s?.srcdoc).toContain('<p>hi</p>');
    expect(s?.allow).toBe('');
  });

  it('never combines allow-scripts and allow-same-origin on a snippet, whatever the input', () => {
    const s = iframeSpecFor({
      source: { html: '<script>1</script>' },
      iframeSrc: 'https://www.youtube.com/embed/x',
      appOrigin: 'https://app.test',
    });
    expect(s?.sandbox).not.toContain('allow-same-origin');
    expect(s?.src).toBeUndefined();
  });

  it('drops allow-same-origin for a frame on the page\'s own origin', () => {
    const s = iframeSpecFor({
      source: { url: 'https://app.test/page' },
      appOrigin: 'https://app.test',
    });
    expect(s?.sandbox).toContain('allow-scripts');
    expect(s?.sandbox).not.toContain('allow-same-origin');
    const other = iframeSpecFor({ source: { url: 'https://other.test/page' }, appOrigin: 'https://app.test' });
    expect(other?.sandbox).toContain('allow-same-origin');
  });

  it('drops allow-same-origin from arbitrary URLs only when arbitrarySameOrigin is false', () => {
    const arb = iframeSpecFor({ source: { url: 'https://other.test/page' }, arbitrarySameOrigin: false });
    expect(arb?.sandbox).toBe('allow-scripts allow-forms allow-popups');
    const dflt = iframeSpecFor({ source: { url: 'https://other.test/page' }, arbitrarySameOrigin: true });
    expect(dflt?.sandbox).toBe(SANDBOX_ARBITRARY);
    const yt = iframeSpecFor({
      source: { url: 'https://youtu.be/dQw4w9WgXcQ' },
      iframeSrc: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      arbitrarySameOrigin: false,
    });
    expect(yt?.sandbox).toBe(SANDBOX_PROVIDER);
  });

  it('never grants navigation, modals, pointer lock, downloads or popup escape', () => {
    const specs = [
      iframeSpecFor({ source: { url: 'https://youtu.be/dQw4w9WgXcQ' }, iframeSrc: 'https://www.youtube-nocookie.com/embed/x' }),
      iframeSpecFor({ source: { url: 'https://example.com' } }),
      iframeSpecFor({ source: { html: 'x' } }),
    ];
    for (const s of specs) for (const f of FORBIDDEN) expect(s?.sandbox).not.toContain(f);
  });

  it('refuses a URL that is not http(s)', () => {
    expect(iframeSpecFor({ source: { url: 'javascript:alert(1)' } })).toBeNull();
    expect(iframeSpecFor({ source: { url: 'https://ok.test' }, iframeSrc: 'data:text/html,x' })).toBeNull();
  });

  it('titles the frame', () => {
    expect(iframeSpecFor({ source: { url: 'https://ok.test', title: 'Ok' } })?.title).toBe('Ok');
    expect(iframeSpecFor({ source: { html: 'x' } })?.title).toBe('Embedded HTML');
  });
});

describe('snippetDocument', () => {
  it('puts the CSP before anything of the snippet', () => {
    const doc = snippetDocument('<script>evil()</script>');
    expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('evil()'));
    expect(doc).toContain(SNIPPET_CSP);
  });
  it('allows inline scripts and styles but no network', () => {
    expect(SNIPPET_CSP).toContain("default-src 'none'");
    expect(SNIPPET_CSP).toContain("script-src 'unsafe-inline'");
    expect(SNIPPET_CSP).not.toContain('connect-src');
  });
});

describe('snippet bootstrap', () => {
  it('comes after the CSP and before the snippet, as one inline script the CSP allows', () => {
    const doc = snippetDocument('<p id="mine">x</p><script>mine()</script>');
    const boot = doc.indexOf(SNIPPET_BOOTSTRAP);
    expect(boot).toBeGreaterThan(doc.indexOf('Content-Security-Policy'));
    expect(boot).toBeLessThan(doc.indexOf('id="mine"'));
    expect(doc).toContain(`<script>${SNIPPET_BOOTSTRAP}</script>`);
    // Unchanged: inline scripts and data: images are all the bootstrap needs.
    expect(SNIPPET_CSP).toContain("script-src 'unsafe-inline'");
    expect(SNIPPET_CSP).toContain('img-src data: https:');
    expect(SNIPPET_BOOTSTRAP).not.toMatch(/<\/script/i);
    expect(() => new Function(SNIPPET_BOOTSTRAP)).not.toThrow();
    expect(SNIPPET_BOOTSTRAP.length).toBeLessThan(5000);
  });

  // The script in a frame of its own: `parent` is the test window, as for a real snippet.
  const boot = () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const w = frame.contentWindow as Window & { eval(s: string): unknown };
    Object.assign(w.document, { getAnimations: () => [] });
    w.eval(SNIPPET_BOOTSTRAP);
    const msg = (data: unknown, source: unknown = w.parent) =>
      w.dispatchEvent(new MessageEvent('message', { data, source: source as Window, origin: location.origin }));
    return { w, msg, close: () => frame.remove(), parent: w.parent };
  };

  it('has no handshake: it neither announces itself nor answers a ping, and stays small', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const w = frame.contentWindow as Window & { eval(s: string): unknown };
    Object.assign(w.document, { getAnimations: () => [] });
    const seen: unknown[] = [];
    const onReply = (e: Event): void => void seen.push((e as MessageEvent).data);
    w.parent.addEventListener('message', onReply);
    w.eval(SNIPPET_BOOTSTRAP);
    w.dispatchEvent(new MessageEvent('message', { data: { cb: EMBED_CB, op: 'ping', n: 1 }, source: w.parent, origin: location.origin }));
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
    expect(SNIPPET_BOOTSTRAP).not.toMatch(/hello|token|ping/i);
    expect(SNIPPET_BOOTSTRAP.length).toBeLessThan(5000);
    w.parent.removeEventListener('message', onReply);
    frame.remove();
  });

  it('holds requestAnimationFrame while paused, and flushes it on resume', async () => {
    const { w, msg, close } = boot();
    const seen: string[] = [];
    w.requestAnimationFrame(() => seen.push('before'));
    msg({ cb: EMBED_CB, op: 'pause' });
    w.requestAnimationFrame(() => seen.push('during'));
    const cancelled = w.requestAnimationFrame(() => seen.push('cancelled'));
    w.cancelAnimationFrame(cancelled);
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toEqual([]);
    msg({ cb: EMBED_CB, op: 'resume' });
    await vi.waitFor(() => expect(seen.sort()).toEqual(['before', 'during']));
    close();
  });

  it('only listens to its parent and to its own protocol', async () => {
    const { w, msg, close } = boot();
    const seen: number[] = [];
    msg({ cb: 'other', op: 'pause' });
    msg({ cb: EMBED_CB, op: 'pause' }, w); // not the parent
    w.requestAnimationFrame(() => seen.push(1));
    await vi.waitFor(() => expect(seen).toEqual([1]));
    close();
  });

  it('answers a snapshot request with the same id: SVG markup, or ok: false when it cannot build it', async () => {
    const { msg, close, parent } = boot();
    const replies: unknown[] = [];
    const onReply = (e: Event): void => {
      const d = (e as MessageEvent).data;
      if (d.op === 'snapshot') replies.push(d);
    };
    parent.addEventListener('message', onReply);
    msg({ cb: EMBED_CB, op: 'snapshot', id: 42, w: 100, h: 50 });
    await vi.waitFor(() => expect(replies).toHaveLength(1), { timeout: 3000 });
    const r = replies[0] as { cb: string; op: string; id: number; ok: boolean; svg?: string };
    expect(r).toMatchObject({ cb: EMBED_CB, op: 'snapshot', id: 42 });
    // jsdom may lack what the clone needs (getAnimations): then an honest no rather than a broken picture.
    if (r.ok) expect(r.svg).toContain('<foreignObject');
    else expect(r.svg).toBeUndefined();
    parent.removeEventListener('message', onReply);
    close();
  });

  it('lays a snapshot out at vw x vh when the window reports no size, and says no when it has none', async () => {
    const { w, msg, close, parent } = boot();
    const replies: Array<{ id: number; ok: boolean; svg?: string }> = [];
    const onReply = (e: Event): void => {
      const d = (e as MessageEvent).data;
      if (d.op === 'snapshot') replies.push(d);
    };
    parent.addEventListener('message', onReply);
    // A frame that is display: none.
    Object.defineProperty(w, 'innerWidth', { value: 0, configurable: true });
    Object.defineProperty(w, 'innerHeight', { value: 0, configurable: true });
    msg({ cb: EMBED_CB, op: 'snapshot', id: 1, w: 100, h: 50, vw: 320, vh: 200 });
    msg({ cb: EMBED_CB, op: 'snapshot', id: 2, w: 100, h: 50 });
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 3000 });
    const [withSize, without] = replies;
    expect(without.ok).toBe(false);
    // jsdom may lack what the clone needs: then an honest no there too.
    if (withSize.ok) expect(withSize.svg).toContain('width="320" height="200"');
    parent.removeEventListener('message', onReply);
    close();
  });

  describe('timers', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('holds a setInterval callback while paused, and runs it after resume', async () => {
      const { w, msg, close } = boot();
      let n = 0;
      msg({ cb: EMBED_CB, op: 'pause' });
      const id = w.setInterval(() => n++, 5);
      await wait(80);
      expect(n).toBe(0);
      msg({ cb: EMBED_CB, op: 'resume' });
      await vi.waitFor(() => expect(n).toBeGreaterThan(0));
      // It goes on by itself, and the id it returned stops it.
      const seen = n;
      await vi.waitFor(() => expect(n).toBeGreaterThan(seen));
      w.clearInterval(id);
      await wait(20);
      const stopped = n;
      await wait(60);
      expect(n).toBe(stopped);
      close();
    });

    it('runs what fell due while paused once on resume, not once per missed tick', async () => {
      const { w, msg, close } = boot();
      const ticks: number[] = [];
      const id = w.setInterval(() => ticks.push(Date.now()), 5);
      msg({ cb: EMBED_CB, op: 'pause' });
      await wait(100);
      const before = ticks.length;
      msg({ cb: EMBED_CB, op: 'resume' });
      await wait(8);
      // About twenty ticks fell due while paused: one catch-up and the interval's own, not the whole backlog.
      expect(ticks.length - before).toBeGreaterThan(0);
      expect(ticks.length - before).toBeLessThan(8);
      w.clearInterval(id);
      close();
    });

    it('holds a setTimeout while paused, fires it on resume, with its arguments, and clearTimeout cancels', async () => {
      const { w, msg, close } = boot();
      const seen: string[] = [];
      msg({ cb: EMBED_CB, op: 'pause' });
      w.setTimeout((a: string, b: string) => seen.push(a + b), 1, 'x', 'y');
      const dropped = w.setTimeout(() => seen.push('dropped'), 1);
      const droppedLater = w.setTimeout(() => seen.push('dropped later'), 1);
      w.clearTimeout(dropped);
      await wait(60);
      expect(seen).toEqual([]);
      w.clearTimeout(droppedLater);
      msg({ cb: EMBED_CB, op: 'resume' });
      await vi.waitFor(() => expect(seen).toEqual(['xy']));
      await wait(30);
      expect(seen).toEqual(['xy']);
      close();
    });

    it('runs timers as usual while not paused, and lets either clear take either id', async () => {
      const { w, close } = boot();
      const seen: number[] = [];
      w.setTimeout(() => seen.push(1), 1);
      w.clearInterval(w.setTimeout(() => seen.push(2), 1));
      w.clearTimeout(w.setInterval(() => seen.push(3), 1));
      await vi.waitFor(() => expect(seen).toEqual([1]));
      await wait(20);
      expect(seen).toEqual([1]);
      close();
    });
  });
});

describe('snippetNetwork', () => {
  it("'images' is today's CSP and the default; 'none' allows no https at all", () => {
    expect(snippetCsp()).toBe(SNIPPET_CSP);
    expect(snippetCsp('images')).toBe(SNIPPET_CSP);
    expect(SNIPPET_CSP).toContain('img-src data: https:');
    expect(SNIPPET_CSP).toContain('font-src https: data:');
    expect(snippetCsp('none')).toBe(SNIPPET_CSP_NONE);
    expect(SNIPPET_CSP_NONE).toContain("default-src 'none'");
    expect(SNIPPET_CSP_NONE).toContain('img-src data: blob:;');
    expect(SNIPPET_CSP_NONE).toContain('font-src data:');
    expect(SNIPPET_CSP_NONE).not.toContain('https:');
  });

  it('puts the chosen policy in the document, before anything of the snippet', () => {
    const none = iframeSpecFor({ source: { html: '<p>hi</p>' }, snippetNetwork: 'none' });
    expect(none?.srcdoc).toContain(`content="${SNIPPET_CSP_NONE}"`);
    expect(none?.srcdoc?.indexOf('Content-Security-Policy')).toBeLessThan(none?.srcdoc?.indexOf('<p>hi</p>') ?? 0);
    expect(iframeSpecFor({ source: { html: '<p>hi</p>' } })?.srcdoc).toContain(`content="${SNIPPET_CSP}"`);
    expect(snippetDocument('<p/>', 'none')).toContain(SNIPPET_CSP_NONE);
  });

  it('hands the snippet CSP to the iframe `csp` attribute (Embedded Enforcement), for snippets only', () => {
    expect(iframeSpecFor({ source: { html: '<p/>' } })?.csp).toBe(SNIPPET_CSP);
    expect(iframeSpecFor({ source: { html: '<p/>' }, snippetNetwork: 'none' })?.csp).toBe(SNIPPET_CSP_NONE);
    expect(iframeSpecFor({ source: { url: 'https://example.com/' } })?.csp).toBeUndefined();
    expect(iframeSpecFor({ source: { url: 'https://youtu.be/dQw4w9WgXcQ' }, iframeSrc: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' })?.csp).toBeUndefined();
  });
});

describe('isolatedHosts', () => {
  const sandbox = (url: string, isolatedHosts?: readonly string[]) => iframeSpecFor({ source: { url }, isolatedHosts })?.sandbox;

  it('drops allow-same-origin for the host and its subdomains, whatever the case or a leading dot', () => {
    const want = 'allow-scripts allow-forms allow-popups';
    expect(sandbox('https://example.com/x', ['example.com'])).toBe(want);
    expect(sandbox('https://App.Example.com/x', ['example.com'])).toBe(want);
    expect(sandbox('https://app.example.com/x', ['.EXAMPLE.com'])).toBe(want);
    expect(sandbox('https://a.b.example.com/x', ['other.org', 'example.com'])).toBe(want);
  });

  it('leaves everything else as it was', () => {
    expect(sandbox('https://notexample.com/x', ['example.com'])).toBe(SANDBOX_ARBITRARY);
    expect(sandbox('https://example.com.evil.org/x', ['example.com'])).toBe(SANDBOX_ARBITRARY);
    expect(sandbox('https://example.com/x', [])).toBe(SANDBOX_ARBITRARY);
    expect(sandbox('https://example.com/x')).toBe(SANDBOX_ARBITRARY);
    // An empty or blank entry matches nothing.
    expect(sandbox('https://example.com/x', ['', ' ', '.'])).toBe(SANDBOX_ARBITRARY);
  });

  it('applies to providers too (the profile is otherwise kept)', () => {
    const s = iframeSpecFor({
      source: { url: 'https://youtu.be/dQw4w9WgXcQ' },
      iframeSrc: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      isolatedHosts: ['youtube-nocookie.com'],
    });
    expect(s?.profile).toBe('provider');
    expect(s?.sandbox).toBe('allow-scripts allow-forms allow-popups allow-presentation');
  });

  it('hostIsolated ignores URLs it cannot parse', () => {
    expect(hostIsolated('not a url', ['example.com'])).toBe(false);
    expect(hostIsolated('https://example.com./', ['example.com'])).toBe(true);
  });

  describe('normalisation', () => {
    it.each([
      ['example.com', 'example.com'],
      ['EXAMPLE.com', 'example.com'],
      ['  Example.COM  ', 'example.com'],
      ['.example.com', 'example.com'],
      ['*.example.com', 'example.com'],
      ['example.com.', 'example.com'],
      ['example.com:443', 'example.com'],
      ['example.com:8080', 'example.com'],
      ['https://example.com', 'example.com'],
      ['https://example.com/', 'example.com'],
      ['https://Example.com:8443/', 'example.com'],
      ['http://example.com./', 'example.com'],
      ['bücher.de', 'xn--bcher-kva.de'],
      ['BÜCHER.de', 'xn--bcher-kva.de'],
      ['xn--bcher-kva.de', 'xn--bcher-kva.de'],
      ['*.bücher.de', 'xn--bcher-kva.de'],
      ['localhost', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
      ['127.0.0.1:3000', '127.0.0.1'],
      ['::1', '[::1]'],
      ['[::1]', '[::1]'],
      ['[::1]:8080', '[::1]'],
      ['https://[::1]:8080/', '[::1]'],
      ['2001:DB8::1', '[2001:db8::1]'],
    ])('%s -> %s', (entry, host) => {
      expect(normalizeIsolatedHost(entry)).toBe(host);
      // Idempotent.
      expect(normalizeIsolatedHost(host)).toBe(host);
    });

    it.each(['', ' ', '.', '..', ' . '])('blank entry %j matches nothing', (entry) => {
      expect(normalizeIsolatedHost(entry)).toBeNull();
      expect(normalizeIsolatedHosts([entry, 'example.com'])).toEqual(['example.com']);
    });

    it.each([
      'example.com/path',
      'example.com/',
      'https://example.com/path',
      'https://example.com/?q=1',
      'https://example.com/#x',
      'example.com?x',
      'example.com#x',
      'user@example.com',
      'https://user:pw@example.com/',
      'https://user@example.com',
      'user:pw@example.com',
      'exa mple.com',
      'example.*',
      'ex*mple.com',
      '*',
      '**.example.com',
      'https://*.example.com',
      'example.com:99999',
      'example.com:abc',
      'https://',
      'http://:80',
      'file:///etc/passwd',
      '[::1',
      '[nope]',
      '-.com',
      'a..b',
    ])('rejects %j with CorkboardError("invalid")', (entry) => {
      expect(() => normalizeIsolatedHost(entry)).toThrow(CorkboardError);
      try {
        normalizeIsolatedHost(entry);
      } catch (e) {
        expect((e as CorkboardError).code).toBe('invalid');
      }
    });

    it('a list with one bad entry throws, naming it', () => {
      expect(() => normalizeIsolatedHosts(['example.com', 'x.org/a'])).toThrow(/"x\.org\/a"/);
    });
  });

  describe('matching', () => {
    // [entry, url, isolated]
    it.each([
      // Domains: the host and its subdomains, in any spelling of the entry.
      ['example.com', 'https://example.com/', true],
      ['example.com', 'https://EXAMPLE.COM/', true],
      ['example.com', 'https://example.com./', true],
      ['example.com', 'https://a.b.example.com/x', true],
      ['example.com', 'https://example.com:8443/x', true],
      ['example.com.', 'https://app.example.com/', true],
      ['EXAMPLE.com', 'https://app.example.com/', true],
      ['.example.com', 'https://app.example.com/', true],
      ['*.example.com', 'https://example.com/', true],
      ['*.example.com', 'https://app.example.com/', true],
      ['example.com:443', 'https://app.example.com/', true],
      ['https://example.com', 'https://app.example.com/', true],
      ['https://example.com/', 'http://example.com/', true],
      ['bücher.de', 'https://bücher.de/', true],
      ['bücher.de', 'https://www.xn--bcher-kva.de/', true],
      ['xn--bcher-kva.de', 'https://BÜCHER.de/', true],
      ['*.bücher.de', 'https://shop.bücher.de/', true],
      // Look-alikes and parents.
      ['example.com', 'https://notexample.com/', false],
      ['example.com', 'https://example.com.evil.org/', false],
      ['example.com', 'https://example.org/', false],
      ['app.example.com', 'https://example.com/', false],
      ['*.example.com', 'https://notexample.com/', false],
      ['bücher.de', 'https://buecher.de/', false],
      // IP literals match exactly, never as a suffix.
      ['127.0.0.1', 'http://127.0.0.1/', true],
      ['127.0.0.1', 'http://127.0.0.1:3000/x', true],
      ['0.1', 'http://127.0.0.1/', false],
      ['1', 'http://127.0.0.1/', false],
      ['0.0.1', 'http://127.0.0.1/', false],
      ['27.0.0.1', 'http://127.0.0.1/', false],
      ['127.0.0.1', 'http://127.0.0.10/', false],
      ['127.0.0.1', 'http://a.127.0.0.1.example.com/', false],
      ['::1', 'http://[::1]/', true],
      ['::1', 'http://[::1]:3000/x', true],
      ['[::1]', 'http://[::1]/', true],
      ['[::1]:8080', 'http://[::1]/', true],
      ['https://[::1]/', 'http://[::1]/', true],
      ['::1', 'http://[::2]/', false],
      ['::1', 'http://[0:0:0:0:0:0:0:1]/', true],
      ['::1', 'http://localhost/', false],
      ['1', 'http://[::1]/', false],
      ['localhost', 'http://localhost:5173/', true],
      ['localhost', 'http://app.localhost/', true],
    ] as const)('entry %j, url %s -> %s', (entry, url, want) => {
      expect(hostIsolated(url, [entry])).toBe(want);
      expect(sandbox(url, [entry])).toBe(want ? 'allow-scripts allow-forms allow-popups' : SANDBOX_ARBITRARY);
    });

    it('rejects a bad entry instead of failing open', () => {
      expect(() => hostIsolated('https://example.com/', ['example.com/path'])).toThrow(CorkboardError);
      expect(() => iframeSpecFor({ source: { url: 'https://example.com/' }, isolatedHosts: ['u:p@example.com'] })).toThrow(CorkboardError);
    });
  });
});
