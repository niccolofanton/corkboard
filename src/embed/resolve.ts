// What is known about an embed card, and how a host's `resolve` option adds to it. Pure.
//
// The library does what needs no server: it recognises a few providers by URL (providers.ts). Everything
// that does need one belongs to the host, behind `EmbedResolver`:
//   - oEmbed (`thumbnail_url`, `title`, the real size of a Vimeo video),
//   - `og:image` of an arbitrary page,
//   - a screenshot (headless Chromium) for pages with neither,
//   - whether the page may be framed at all (`X-Frame-Options`, CSP `frame-ancestors`): the browser cannot
//     tell, a cross-origin iframe reports neither `onload` nor `onerror` honestly.
// All of it should be cached and the poster re-hosted CORS-enabled (a WebGL texture needs CORS).
import type { EmbedSource } from '../types';
import {
  normalizeEmbedUrl,
  parseEmbedUrl,
  PROVIDER_LABEL,
  type EmbedProvider,
} from './providers';

// What a resolver may tell about a URL. Every field is optional; what it leaves out stays as the library
// derived it.
export interface EmbedInfo {
  // A CORS-readable image URL for the poster.
  poster?: string;
  // The URL to load in the iframe, when it is not the card's `url` (an oEmbed `iframe` src, say).
  iframeSrc?: string;
  // height / width of the card.
  aspect?: number;
  title?: string;
  // false: the page refuses framing. The card is a bookmark: it never goes live, and a double-click opens
  // the URL in a new tab.
  frameable?: boolean;
}

// Example (a Cloudflare Worker that caches oEmbed / og:image / framing headers per URL):
//
//   resolve: async (url) => {
//     const r = await fetch(`/api/embed-info?url=${encodeURIComponent(url)}`);
//     return r.ok ? ((await r.json()) as EmbedInfo) : null;
//   }
export type EmbedResolver = (url: string) => Promise<EmbedInfo | null | undefined> | EmbedInfo | null | undefined;

// Everything the layer knows about a card's embed, settled.
export interface ResolvedEmbed {
  kind: 'url' | 'html';
  provider: EmbedProvider;
  // The card's URL (normalised), or '' for a snippet.
  url: string;
  host: string;
  // What the tile says: the provider, else the host; the title if there is one.
  label: string;
  title?: string;
  // The URL to load live. null: the card cannot go live (not an http(s) URL) or is a snippet.
  iframeSrc: string | null;
  frameable: boolean;
  aspect?: number;
  // Poster candidates, best first.
  posters: string[];
}

// The synchronous part: what the URL alone says.
export function baseResolved(embed: EmbedSource): ResolvedEmbed {
  if (embed.html !== undefined) {
    return {
      kind: 'html',
      provider: 'generic',
      url: '',
      host: 'html',
      label: 'HTML',
      title: embed.title,
      iframeSrc: null,
      frameable: true,
      posters: [],
    };
  }
  const parsed = parseEmbedUrl(embed.url ?? '');
  if (!parsed) {
    return {
      kind: 'url',
      provider: 'generic',
      url: '',
      host: 'invalid URL',
      label: 'Invalid URL',
      title: embed.title,
      iframeSrc: null,
      frameable: false,
      posters: [],
    };
  }
  return {
    kind: 'url',
    provider: parsed.provider,
    url: parsed.url,
    host: parsed.host,
    label: parsed.provider === 'generic' ? parsed.host : PROVIDER_LABEL[parsed.provider],
    title: embed.title,
    iframeSrc: parsed.iframeSrc,
    frameable: true,
    aspect: parsed.aspect,
    posters: parsed.posters,
  };
}

const finitePositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

// A resolver's answer over the base. Untrusted: an `iframeSrc` that is not an http(s) URL is ignored, a
// resolver cannot make a snippet frameable or a card load something the URL parser refused.
export function mergeResolved(base: ResolvedEmbed, info: EmbedInfo | null | undefined): ResolvedEmbed {
  if (!info || base.kind === 'html') return base;
  const out: ResolvedEmbed = { ...base };
  if (typeof info.title === 'string' && info.title !== '') out.title = base.title ?? info.title;
  if (finitePositive(info.aspect)) out.aspect = info.aspect;
  if (typeof info.iframeSrc === 'string' && out.iframeSrc !== null) {
    const src = normalizeEmbedUrl(info.iframeSrc);
    if (src !== null) out.iframeSrc = src;
  }
  if (info.frameable === false) out.frameable = false;
  if (typeof info.poster === 'string' && info.poster !== '') {
    out.posters = [info.poster, ...base.posters.filter((p) => p !== info.poster)];
  }
  return out;
}

// Can the card go live?
export const canGoLive = (r: ResolvedEmbed): boolean =>
  r.frameable && (r.kind === 'html' || r.iframeSrc !== null);

// Do two embeds describe the same content? (A card whose embed did not change keeps its poster and its live
// frame.) The title and the resolution are labels, not content.
export const sameEmbed = (a: EmbedSource, b: EmbedSource): boolean => a.url === b.url && a.html === b.html;
