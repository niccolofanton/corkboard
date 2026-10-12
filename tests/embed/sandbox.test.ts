import { describe, expect, it } from 'vitest';
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

  it('never grants navigation, modals, pointer lock, downloads or popup escape', () => {
    const specs = [
      iframeSpecFor({ source: { url: 'https://youtu.be/dQw4w9WgXcQ' }, iframeSrc: 'https://www.youtube.com/embed/x' }),
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
