// The iframe attributes of a live embed. Pure. The profile is computed at render time from what the card
// holds and the host that serves the iframe, and is never stored in the board: a tampered or shared board
// cannot escalate it.
import type { EmbedSource } from '../types';
import { SNIPPET_BOOTSTRAP } from './bootstrap';
import { normalizeEmbedUrl, providerOfIframeSrc, type EmbedProvider } from './providers';

export type SandboxProfile = 'provider' | 'arbitrary' | 'snippet';

// Allowlisted providers: they run their player (scripts, their own origin's storage), post forms, open
// popups and go presentation mode.
export const SANDBOX_PROVIDER =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation';
// Any other URL: the same minus presentation.
//
// `allow-same-origin` is kept here on purpose: many sites break without their own cookies and storage.
// The risk: the sandbox flags survive navigation inside the frame, so a link the user follows in interact
// mode loads the next site with scripts AND its real origin (cookies, storage, credentialed requests to
// its own server). It never reaches the board's page (another origin; a frame on the app's own origin loses
// the flag, see `appOrigin`). `embeds.arbitrarySameOrigin: false` drops the flag for every arbitrary URL
// (opaque origin: no cookies, no storage), at the cost of the sites that need them.
export const SANDBOX_ARBITRARY = 'allow-scripts allow-same-origin allow-forms allow-popups';
// User HTML: scripts only. No `allow-same-origin` (the frame gets an opaque origin: no cookies, no storage,
// no parent DOM), no forms, no popups.
export const SANDBOX_SNIPPET = 'allow-scripts';

// Never granted, whatever the profile: allow-top-navigation*, allow-modals, allow-pointer-lock,
// allow-downloads, allow-popups-to-escape-sandbox.

export const SNIPPET_CSP =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src https: data:";

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

export interface IframeSpec {
  profile: SandboxProfile;
  provider: EmbedProvider;
  // Exactly one of the two.
  src?: string;
  srcdoc?: string;
  sandbox: string;
  // The Permissions-Policy `allow` attribute (it also covers fullscreen: no `allowfullscreen` attribute).
  // Empty: nothing delegated.
  allow: string;
  referrerPolicy: typeof REFERRER_POLICY;
  loading: 'lazy';
  title: string;
}

// `<!doctype html>` and the CSP `<meta>` come first so nothing in the snippet is parsed before the policy.
// A snippet cannot loosen it (several policies only intersect), nor can it unset the sandbox.
// Then the bootstrap (bootstrap.ts: pause / resume / snapshot for the layer), which runs before the snippet's
// own scripts so it can gate requestAnimationFrame. The CSP already allows inline scripts, so it is unchanged.
export function snippetDocument(html: string): string {
  return (
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SNIPPET_CSP}">` +
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

export interface IframeInput {
  source: EmbedSource;
  // The URL to load, when it is not `source.url` (the provider's embed URL, or a resolver's).
  iframeSrc?: string;
  // The origin of the page hosting the board: a frame on it never gets `allow-same-origin`.
  appOrigin?: string;
  // Keep `allow-same-origin` on arbitrary URLs (default true). See SANDBOX_ARBITRARY.
  arbitrarySameOrigin?: boolean;
}

// null: nothing safe to load (not an http(s) URL).
export function iframeSpecFor(input: IframeInput): IframeSpec | null {
  const { source } = input;
  const title = source.title ?? (source.url !== undefined ? 'Embedded page' : 'Embedded HTML');
  if (source.html !== undefined) {
    return {
      profile: 'snippet',
      provider: 'generic',
      srcdoc: snippetDocument(source.html),
      sandbox: SANDBOX_SNIPPET,
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
  // `allow-scripts` + `allow-same-origin` on the app's own origin lets the frame remove its sandbox.
  if (input.appOrigin !== undefined && originOf(src) === input.appOrigin) {
    sandbox = sandbox.replace(' allow-same-origin', '');
  }
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
