// The iframe attributes of a live embed. Pure. The profile is computed at render time from what the card
// holds and the host that serves the iframe, and is never stored in the board: a tampered or shared board
// cannot escalate it.
import { CorkboardError } from '../errors';
import type { EmbedSource } from '../types';
import { SNIPPET_BOOTSTRAP } from './bootstrap';
import { normalizeEmbedUrl, providerOfIframeSrc, type EmbedProvider } from './providers';

/** How much a frame is trusted: a known `provider`, an `arbitrary` URL or an HTML `snippet`. */
export type SandboxProfile = 'provider' | 'arbitrary' | 'snippet';

/**
 * Allowlisted providers: they run their player (scripts, their own origin's storage), post forms, open
 * popups and go presentation mode.
 */
export const SANDBOX_PROVIDER =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation';
/**
 * Any other URL: the same minus presentation.
 *
 * `allow-same-origin` is kept here on purpose: many sites break without their own cookies and storage.
 * The risk: the sandbox flags survive navigation inside the frame, so a link the user follows in interact
 * mode loads the next site with scripts AND its real origin (cookies, storage, credentialed requests to
 * its own server). It never reaches the board's page unless that page is itself served from the same origin
 * (see `appOrigin`, which is best-effort: it only looks at the URL the frame starts with). Never serve
 * user-controlled HTML on the board's origin. `arbitrarySameOrigin: false` drops the flag for every
 * arbitrary URL (opaque origin: no cookies, no storage), `isolatedHosts` for the hosts it names, at the cost
 * of the sites that need them.
 */
export const SANDBOX_ARBITRARY = 'allow-scripts allow-same-origin allow-forms allow-popups';
/**
 * User HTML: scripts only. No `allow-same-origin` (the frame gets an opaque origin: no cookies, no storage,
 * no parent DOM), no forms, no popups.
 */
export const SANDBOX_SNIPPET = 'allow-scripts';

// Never granted, whatever the profile: allow-top-navigation*, allow-modals, allow-pointer-lock,
// allow-downloads, allow-popups-to-escape-sandbox.

/**
 * What an HTML snippet may load. `'images'`: pictures and fonts over https (still requests to any server, so a snippet can tell one it was shown).
 * `'none'`: only what it carries itself (`data:` and `blob:`): no subresource request (image, font, `fetch`...) is
 * allowed. Advisory, not isolation. The CSP is the policy of the snippet's own document, and a snippet can
 * navigate its own frame (`location.href = 'https://x/?...'`): that request always leaves (its URL can carry data
 * out), and the page that answers is not under the snippet CSP. Chromium additionally enforces the CSP on whatever
 * the frame navigates to (the iframe `csp` attribute, see `IframeSpec.csp`), so there the page does not run; other
 * engines run it, for as long as it likes. The layer's navigation guard is best effort against accidents (a link
 * clicked in interact mode), not a security boundary. Only serving snippets from a separate origin would be one.
 */
export type SnippetNetwork = 'images' | 'none';

/** The CSP of a snippet with `snippetNetwork: 'images'`. */
export const SNIPPET_CSP =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src https: data:";
/** The CSP of a snippet with `snippetNetwork: 'none'`. */
export const SNIPPET_CSP_NONE =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";

/** The CSP a snippet document carries for a `snippetNetwork` mode. */
export const snippetCsp = (network: SnippetNetwork = 'images'): string =>
  network === 'none' ? SNIPPET_CSP_NONE : SNIPPET_CSP;

/** The referrer policy of every embed frame. */
export const REFERRER_POLICY = 'strict-origin-when-cross-origin';

const MEDIA_ALLOW = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
const ALLOW: Record<EmbedProvider, string> = {
  youtube: MEDIA_ALLOW,
  vimeo: MEDIA_ALLOW,
  // Audio: full playback needs EME, there is no picture to pop out.
  spotify: 'autoplay; encrypted-media',
  codepen: '',
  figma: '',
  generic: '',
};

/** The attributes an embed frame is created with: `sandbox`, `allow`, `referrerpolicy`, `src` or `srcdoc`. */
export interface IframeSpec {
  profile: SandboxProfile;
  provider: EmbedProvider;
  // Exactly one of the two.
  src?: string;
  srcdoc?: string;
  sandbox: string;
  // Snippets: the CSP the iframe `csp` attribute carries (Embedded Enforcement, Chromium only: every document the
  // frame loads must accept it, so a page it navigates to that does not send `Allow-CSP-From` is blocked instead
  // of run). Other engines ignore the attribute.
  csp?: string;
  // The Permissions-Policy `allow` attribute (it also covers fullscreen: no `allowfullscreen` attribute).
  // Empty: nothing delegated.
  allow: string;
  referrerPolicy: typeof REFERRER_POLICY;
  loading: 'lazy';
  title: string;
}

/**
 * `<!doctype html>` and the CSP `<meta>` come first so nothing in the snippet is parsed before the policy.
 * A snippet cannot loosen it (several policies only intersect), nor can it unset the sandbox.
 * Then the bootstrap (bootstrap.ts: pause / resume / snapshot for the layer), which runs before the snippet's
 * own scripts so it can gate requestAnimationFrame. The CSP already allows inline scripts, so it is unchanged.
 *
 * This policy is the document's own. The host page's CSP applies on top of it (a `srcdoc` frame inherits it):
 * a nonce-based `script-src` there blocks the bootstrap and the snippet's inline scripts.
 */
export function snippetDocument(html: string, network: SnippetNetwork = 'images'): string {
  return (
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${snippetCsp(network)}">` +
    `<meta charset="utf-8"><script>${SNIPPET_BOOTSTRAP}</script>${html}`
  );
}

const originOf = (u: string): string | null => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOSTNAME = /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Whether a canonical host (`URL.hostname`, no trailing dot) is an IP literal: v4, or v6 in brackets. */
const isIpHost = (host: string): boolean => IPV4.test(host) || host.startsWith('[');

const invalidHost = (entry: string, why: string): CorkboardError =>
  new CorkboardError('invalid', `isolatedHosts: "${entry}" is not a host (${why})`);

/**
 * One `isolatedHosts` entry as the host it names: lowercase, punycode, no port, no trailing dot, IPv6 in brackets.
 * Accepts a bare host (`example.com`, `bücher.de`, `.example.com`, `*.example.com`, `example.com:443`, `::1`,
 * `[::1]`) or a full URL (`https://example.com/`: its host). null: blank (matches nothing). Throws
 * `CorkboardError('invalid')` for what is no host: a path, credentials, a query, a wildcard anywhere but the front,
 * or something that cannot be parsed. Idempotent.
 */
export function normalizeIsolatedHost(entry: string): string | null {
  const raw = entry.trim();
  let rest = raw;
  const isUrl = SCHEME.test(rest);
  if (!isUrl) rest = rest.replace(/^(?:\*\.|\.+)/, '');
  if (rest === '' || rest === '.') return null;
  if (!isUrl) {
    // A bare IPv6 literal has no brackets to hold it apart from a port.
    if (rest.split(':').length > 2 && !rest.includes('[')) rest = `[${rest}]`;
    if (/[\s/\\?#@*]/.test(rest)) throw invalidHost(raw, 'only a host, optionally with a port');
    rest = `https://${rest}`;
  }
  let u: URL;
  try {
    u = new URL(rest);
  } catch {
    throw invalidHost(raw, 'it cannot be parsed');
  }
  if (u.username !== '' || u.password !== '') throw invalidHost(raw, 'credentials');
  if ((u.pathname !== '' && u.pathname !== '/') || u.search !== '' || u.hash !== '') throw invalidHost(raw, 'a path, query or fragment');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || (!isIpHost(host) && (!HOSTNAME.test(host) || host.includes('..')))) throw invalidHost(raw, 'it cannot be parsed');
  return host;
}

/**
 * The canonical hosts of an `isolatedHosts` list (see {@link normalizeIsolatedHost}); blank entries are dropped.
 * Throws `CorkboardError('invalid')` for an entry that is no host.
 */
export function normalizeIsolatedHosts(entries: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of entries ?? []) {
    const host = normalizeIsolatedHost(entry);
    if (host !== null) out.push(host);
  }
  return out;
}

/**
 * Whether `url`'s host is one of `hosts` or a subdomain of one. Entries are normalised first (see
 * {@link normalizeIsolatedHost}; it throws for one that is no host). A domain entry covers itself and its
 * subdomains (`example.com` and `.example.com` and `*.example.com` alike); an IP literal covers exactly that
 * address and is never a suffix (`0.1` does not cover `127.0.0.1`).
 */
export function hostIsolated(url: string, hosts: readonly string[] | undefined): boolean {
  if (!hosts || hosts.length === 0) return false;
  const list = normalizeIsolatedHosts(hosts);
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  for (const h of list) {
    if (host === h || (!isIpHost(h) && host.endsWith(`.${h}`))) return true;
  }
  return false;
}

/** What decides an embed frame's attributes. */
export interface IframeInput {
  source: EmbedSource;
  // The URL to load, when it is not `source.url` (the provider's embed URL, or a resolver's).
  iframeSrc?: string;
  // The origin of the page hosting the board: a frame on it never gets `allow-same-origin`.
  appOrigin?: string;
  // Keep `allow-same-origin` on arbitrary URLs (default true). See SANDBOX_ARBITRARY.
  arbitrarySameOrigin?: boolean;
  // Hosts (and their subdomains; an IP literal only itself) whose frames never get `allow-same-origin`, whatever
  // the profile. Normalised by `hostIsolated`, which throws for an entry that is no host. Like
  // `appOrigin`, it judges the URL the frame starts with: a redirect or a link followed in interact mode is
  // not looked at.
  isolatedHosts?: readonly string[];
  // What a snippet may load (default 'images'). See SnippetNetwork.
  snippetNetwork?: SnippetNetwork;
}

/** null: nothing safe to load (not an http(s) URL). */
export function iframeSpecFor(input: IframeInput): IframeSpec | null {
  const { source } = input;
  const title = source.title ?? (source.url !== undefined ? 'Embedded page' : 'Embedded HTML');
  if (source.html !== undefined) {
    return {
      profile: 'snippet',
      provider: 'generic',
      srcdoc: snippetDocument(source.html, input.snippetNetwork),
      sandbox: SANDBOX_SNIPPET,
      csp: snippetCsp(input.snippetNetwork),
      allow: '',
      referrerPolicy: REFERRER_POLICY,
      loading: 'lazy',
      title,
    };
  }
  const src = normalizeEmbedUrl(input.iframeSrc ?? source.url ?? '');
  if (src === null) return null;
  const provider = providerOfIframeSrc(src);
  const allowlisted = provider !== 'generic';
  let sandbox = allowlisted ? SANDBOX_PROVIDER : SANDBOX_ARBITRARY;
  if (!allowlisted && input.arbitrarySameOrigin === false) sandbox = sandbox.replace(' allow-same-origin', '');
  // `allow-scripts` + `allow-same-origin` on the app's own origin lets the frame remove its sandbox. Best
  // effort: only the URL the frame starts with is checked, not where it ends up.
  if (input.appOrigin !== undefined && originOf(src) === input.appOrigin) {
    sandbox = sandbox.replace(' allow-same-origin', '');
  }
  if (hostIsolated(src, input.isolatedHosts)) sandbox = sandbox.replace(' allow-same-origin', '');
  const allow = ALLOW[provider];
  return {
    profile: allowlisted ? 'provider' : 'arbitrary',
    provider,
    src,
    sandbox,
    allow,
    referrerPolicy: REFERRER_POLICY,
    loading: 'lazy',
    title,
  };
}
