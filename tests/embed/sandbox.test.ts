import { describe, expect, it, vi } from 'vitest';
import { EMBED_CB, SNIPPET_BOOTSTRAP } from '../../src/embed/bootstrap';
import {
  iframeSpecFor,
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
    const onReply = (e: Event): void => void replies.push((e as MessageEvent).data);
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
    const onReply = (e: Event): void => void replies.push((e as MessageEvent).data);
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

  it('answers show with painted, with the same id, even while paused', async () => {
    const { msg, close, parent } = boot();
    const replies: Array<{ cb: string; op: string; id: number }> = [];
    const onReply = (e: Event): void => void replies.push((e as MessageEvent).data);
    parent.addEventListener('message', onReply);
    msg({ cb: EMBED_CB, op: 'pause' });
    msg({ cb: 'other', op: 'show', id: 8 });
    msg({ cb: EMBED_CB, op: 'show', id: 9 });
    await vi.waitFor(() => expect(replies).toHaveLength(1), { timeout: 3000 });
    expect(replies[0]).toEqual({ cb: EMBED_CB, op: 'painted', id: 9 });
    parent.removeEventListener('message', onReply);
    close();
  });
});
