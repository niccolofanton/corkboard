// URL parsing and provider recognition for `embed` cards. Pure: no DOM, no network.
//
// A pasted URL becomes a `ParsedEmbed`: the iframe URL to load live (`youtube.com/watch?v=x` ->
// `youtube-nocookie.com/embed/x`), the poster candidates that need no server, and the shape of the card.
// What cannot be known here (oEmbed titles, og:image, `X-Frame-Options`) belongs to the host's `resolve`
// option, on a server (see EmbedResolver in resolve.ts).

/** Providers recognised from a URL. They get a nocookie / embed URL, a natural card shape and a poster that needs no server; any other URL is `'generic'`. */
export type EmbedProvider = 'youtube' | 'vimeo' | 'spotify' | 'codepen' | 'figma' | 'generic';

/** What a URL says about an embed card, without a network request. */
export interface ParsedEmbed {
  /** The URL as the card keeps it: https, no credentials. */
  url: string;
  /** Host without `www.`, for the generated tile. */
  host: string;
  /** Which provider the URL belongs to. */
  provider: EmbedProvider;
  /** What the iframe loads when the card goes live. */
  iframeSrc: string;
  /** `aspect`: height / width of the card for this provider, when it has a natural one. */
  aspect?: number;
  /** Poster URLs that need no server, best first (each must be CORS-readable; the layer probes them). */
  posters: string[];
  /** A human label for the tile ("YouTube"). */
  label: string;
}

/** The human label of each provider, as shown on a tile. */
export const PROVIDER_LABEL: Record<EmbedProvider, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  spotify: 'Spotify',
  codepen: 'CodePen',
  figma: 'Figma',
  generic: 'Web page',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Cleans a URL for an embed card: only http(s) URLs without credentials. `http:` is upgraded to `https:` except on
 * localhost (dev) and on an explicit port (a LAN or dev server there has no TLS). `javascript:`, `data:`, `file:`,
 * `blob:` and the rest are refused.
 *
 * @returns The normalised URL, or `null` when it cannot be an embed.
 */
export function normalizeEmbedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol === 'http:' && !LOCAL_HOSTS.has(u.hostname) && u.port === '') u.protocol = 'https:';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username !== '' || u.password !== '') return null;
  return u.toString();
}

const stripWww = (h: string): string => h.replace(/^www\./, '');

/** `90`, `90s`, `1m30s`, `1h2m3s` -> seconds. */
export function parseTimestamp(t: string | null): number | null {
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const YT_ID = /^[\w-]{11}$/;
// Path words that are 11 word characters long, so they look like a video id.
const YT_PATH_WORDS = new Set(['videoseries', 'live_stream']);
// A playlist or channel id: word characters and dashes only, so it is safe in the iframe URL.
const YT_LIST = /^[\w-]+$/;
const YT_HOSTS = new Set([
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
]);

const ytParam = (u: URL, name: string): string | null => {
  const v = u.searchParams.get(name);
  return v !== null && YT_LIST.test(v) ? v : null;
};

const ytEmbed = (path: string, params: Record<string, string>): string => {
  const q = new URLSearchParams(params).toString();
  return `https://www.youtube-nocookie.com/embed/${path}` + (q ? `?${q}` : '');
};

function parseYouTube(u: URL, host: string): Omit<ParsedEmbed, 'url' | 'host' | 'label'> | null {
  if (!YT_HOSTS.has(host)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  // A playlist or a live stream has no video id: `embed/videoseries?list=` and `embed/live_stream?channel=`.
  // No ytimg poster either (there is no id to ask for): the card gets the generated tile.
  if (host !== 'youtu.be' && parts[0] === 'embed' && YT_PATH_WORDS.has(parts[1] ?? '')) {
    const series = parts[1] === 'videoseries';
    const value = ytParam(u, series ? 'list' : 'channel');
    if (value === null) return null;
    return {
      provider: 'youtube',
      iframeSrc: ytEmbed(parts[1], series ? { list: value } : { channel: value }),
      aspect: 9 / 16,
      posters: [],
    };
  }
  let id: string | null = null;
  if (host === 'youtu.be') id = parts[0] ?? null;
  else if (parts[0] === 'watch') id = u.searchParams.get('v');
  else if (['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? null;
  if (id === null || !YT_ID.test(id) || YT_PATH_WORDS.has(id)) return null;
  const start = parseTimestamp(u.searchParams.get('t') ?? u.searchParams.get('start'));
  // A video watched inside a playlist keeps the playlist.
  const list = ytParam(u, 'list');
  const params: Record<string, string> = {};
  if (list !== null) params.list = list;
  if (start) params.start = String(start);
  return {
    provider: 'youtube',
    iframeSrc: ytEmbed(id, params),
    aspect: 9 / 16,
    // maxresdefault (1280x720) is missing on some videos; mqdefault (320x180) is always there and, unlike
    // hqdefault, has no letterbox bars.
    posters: [
      `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    ],
  };
}

// Pages that list videos: a bare one (no `video` segment) is not a video.
const VIMEO_LISTS = new Set(['showcase', 'album', 'event']);

function parseVimeo(u: URL, host: string): Omit<ParsedEmbed, 'url' | 'host' | 'label'> | null {
  if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const isId = (p: string | undefined): boolean => p !== undefined && /^\d+$/.test(p);
  // The digits after `video` / `videos` (`showcase/987/video/123`, `player.vimeo.com/video/123`), else the
  // first number (`123`, `channels/staffpicks/123`) unless the page is a showcase, album or event.
  const v = parts.findIndex((p) => p === 'video' || p === 'videos');
  let i = -1;
  if (v >= 0) i = isId(parts[v + 1]) ? v + 1 : -1;
  else if (!VIMEO_LISTS.has(parts[0] ?? '')) i = parts.findIndex(isId);
  if (i < 0) return null;
  const id = parts[i];
  // An unlisted video carries a hash: `vimeo.com/ID/HASH` or `?h=HASH`.
  const next = parts[i + 1];
  // Only hex goes into the iframe URL: `?h=abc&autoplay=1` or anything else a link carries is dropped.
  const q = u.searchParams.get('h');
  const hash = q !== null && /^[0-9a-f]+$/i.test(q) ? q : next && /^[0-9a-f]{8,}$/i.test(next) ? next : null;
  return {
    provider: 'vimeo',
    iframeSrc:
      `https://player.vimeo.com/video/${id}` + (hash ? `?${new URLSearchParams({ h: hash }).toString()}` : ''),
    aspect: 9 / 16,
    posters: [],
  };
}

const SPOTIFY_TYPES = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist']);

function parseSpotify(u: URL, host: string): Omit<ParsedEmbed, 'url' | 'host' | 'label'> | null {
  if (host !== 'open.spotify.com') return null;
  let parts = u.pathname.split('/').filter(Boolean);
  // `/intl-it/track/ID` and `/embed/track/ID`.
  if (parts[0]?.startsWith('intl-')) parts = parts.slice(1);
  if (parts[0] === 'embed') parts = parts.slice(1);
  const [type, id] = parts;
  if (!type || !SPOTIFY_TYPES.has(type) || !id || !/^[A-Za-z0-9]{22}$/.test(id)) return null;
  const compact = type === 'track' || type === 'episode';
  return {
    provider: 'spotify',
    iframeSrc: `https://open.spotify.com/embed/${type}/${id}`,
    // The player is 152 px (compact) or 352 px tall at any width; 400 px is the card's default width.
    aspect: compact ? 152 / 400 : 352 / 400,
    posters: [],
  };
}

function parseCodePen(u: URL, host: string): Omit<ParsedEmbed, 'url' | 'host' | 'label'> | null {
  if (host !== 'codepen.io') return null;
  let parts = u.pathname.split('/').filter(Boolean);
  let team = '';
  if (parts[0] === 'team') {
    team = 'team/';
    parts = parts.slice(1);
  }
  const [user, kind, id] = parts;
  if (!user || !id || !['pen', 'full', 'details', 'embed', 'debug'].includes(kind ?? '')) return null;
  if (!/^[A-Za-z0-9]+$/.test(id)) return null;
  return {
    provider: 'codepen',
    iframeSrc: `https://codepen.io/${team}${user}/embed/${id}?default-tab=result`,
    aspect: 5 / 8,
    posters: [],
  };
}

function parseFigma(u: URL, host: string): Omit<ParsedEmbed, 'url' | 'host' | 'label'> | null {
  if (host !== 'figma.com') return null;
  if (u.pathname === '/embed') return null;
  const kind = u.pathname.split('/').filter(Boolean)[0];
  if (!kind || !['file', 'design', 'proto', 'board', 'slides', 'deck'].includes(kind)) return null;
  return {
    provider: 'figma',
    iframeSrc: `https://www.figma.com/embed?embed_host=corkboard&url=${encodeURIComponent(u.toString())}`,
    aspect: 3 / 4,
    posters: [],
  };
}

const PARSERS = [parseYouTube, parseVimeo, parseSpotify, parseCodePen, parseFigma];

/**
 * Parses a pasted URL into what an embed card needs: provider, iframe URL (`youtube.com/watch?v=x` becomes
 * `youtube-nocookie.com/embed/x`), poster candidates and the card's shape. Use it to validate input before it
 * becomes a card. Any other http(s) URL parses as `generic` (loaded as is, with the stricter sandbox).
 *
 * @returns `null` when the URL is not http(s).
 */
export function parseEmbedUrl(raw: string): ParsedEmbed | null {
  const url = normalizeEmbedUrl(raw);
  if (url === null) return null;
  const u = new URL(url);
  const host = stripWww(u.hostname);
  for (const parse of PARSERS) {
    const hit = parse(u, host);
    if (hit) return { ...hit, url, host, label: PROVIDER_LABEL[hit.provider] };
  }
  return {
    url,
    host,
    provider: 'generic',
    iframeSrc: url,
    posters: [],
    label: PROVIDER_LABEL.generic,
  };
}

// The provider that SERVES an iframe URL, by its host and path. The sandbox profile follows this and never
// what a card claims, so a resolver (or a tampered board) cannot name an arbitrary page "youtube". Only the
// embed URLs the parsers above emit are listed: the same host's other paths (`youtube.com/redirect?q=...`)
// are arbitrary pages.
const ALLOWLIST: readonly { host: string; path: RegExp; provider: EmbedProvider }[] = [
  { host: 'www.youtube-nocookie.com', path: /^\/embed\//, provider: 'youtube' },
  { host: 'player.vimeo.com', path: /^\/video\//, provider: 'vimeo' },
  { host: 'open.spotify.com', path: /^\/embed\//, provider: 'spotify' },
  { host: 'codepen.io', path: /^\/(?:team\/)?[^/]+\/embed\//, provider: 'codepen' },
  { host: 'www.figma.com', path: /^\/embed$/, provider: 'figma' },
];

/** The provider an iframe URL belongs to. */
export function providerOfIframeSrc(src: string): EmbedProvider {
  try {
    const u = new URL(src);
    if (u.protocol !== 'https:') return 'generic';
    return ALLOWLIST.find((r) => r.host === u.hostname && r.path.test(u.pathname))?.provider ?? 'generic';
  } catch {
    return 'generic';
  }
}

/**
 * The iframe URL of a video provider, set to start playing on its own and muted (browsers only let a muted
 * page autoplay), inline on iOS and looping. YouTube needs `playlist=<id>` to loop a single video; a
 * `list` the URL already carries is kept instead. Vimeo keeps its unlisted-video `h` hash. Any other
 * provider (or a URL that does not parse) comes back as is. Pure; the stored embed info is never touched.
 */
export function withAutoplay(provider: EmbedProvider, src: string): string {
  if (provider !== 'youtube' && provider !== 'vimeo') return src;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return src;
  }
  const q = u.searchParams;
  if (provider === 'vimeo') {
    q.set('autoplay', '1');
    q.set('muted', '1');
    q.set('loop', '1');
  } else {
    const word = u.pathname.split('/')[2] ?? '';
    q.set('autoplay', '1');
    q.set('mute', '1');
    q.set('playsinline', '1');
    // A live stream has nothing to loop.
    if (word !== 'live_stream') q.set('loop', '1');
    if (word !== 'videoseries' && word !== 'live_stream' && !q.has('list')) q.set('playlist', word);
  }
  return u.toString();
}

/**
 * A YouTube iframe URL with its postMessage API on (`enablejsapi=1`, plus `origin` when the page's is an
 * http(s) one: the player ignores commands from a page it cannot match). The layer pauses and resumes the
 * player with it. Vimeo's player takes its commands without a flag; any other provider (or a URL that does
 * not parse) comes back as is. Pure; the stored embed info is never touched.
 */
export function withJsApi(provider: EmbedProvider, src: string, origin?: string): string {
  if (provider !== 'youtube') return src;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return src;
  }
  u.searchParams.set('enablejsapi', '1');
  if (origin !== undefined && /^https?:\/\//.test(origin)) u.searchParams.set('origin', origin);
  return u.toString();
}

/** Whether a provider is one the library knows (its pages get the sandbox of a provider). */
export const isAllowlisted = (p: EmbedProvider): boolean => p !== 'generic';
