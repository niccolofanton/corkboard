import {
  Corkboard,
  type ElementInit,
  type EmbedInfo,
  type EmbedResolution,
  type VideoMode,
} from 'corkboard';
import { startPerfPanel } from './perfChart';
import { makeSnippet, makeWindows, placeWindows } from './windows';

const COUNT = 600;
// `?windows=1000`: a board of that many different, autoplaying embeds (capped) instead of the picture cards.
const WINDOWS = (() => {
  const n = Number(new URLSearchParams(location.search).get('windows'));
  return Number.isInteger(n) && n > 0 ? Math.min(n, 5000) : 0;
})();
const WINDOWS_BUTTON = 1000;
// height / width of the pictures: a mix of portrait, square and landscape cards.
const ASPECTS = [1.5, 1.25, 1, 0.75, 1.33, 0.66, 1.78, 1.1];
// Public sample clips (served with CORS). Video cards play in a <video> laid over the poster.
const VIDEOS = [
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4',
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
];

// A tiny seeded generator, so a reload shows the same board.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(7);
let nextSeed = 1;

function picsum(seed: number, w: number, aspect: number): string {
  return `https://picsum.photos/seed/${seed}/${w}/${Math.round(w * aspect)}`;
}

// Share of the grid that is live HTML (an animated snippet in a sandboxed iframe) rather than a picture.
const SNIPPET_SHARE = 0.15;

function makeCards(n: number): ElementInit[] {
  const out: ElementInit[] = [];
  for (let i = 0; i < n; i++) {
    const seed = nextSeed++;
    if (rand() < SNIPPET_SHARE) {
      // Aspect-locked like the pictures, so the grid gives it the column's width.
      out.push({
        ...makeSnippet(rand, seed, `Snippet #${String(seed).padStart(4, '0')}`),
        w: 200 + Math.round(rand() * 100),
        aspectLocked: true,
      });
      continue;
    }
    const aspect = ASPECTS[Math.floor(rand() * ASPECTS.length)];
    const hue = Math.floor(rand() * 360);
    const media = {
      src: picsum(seed, 480, aspect),
      // Three sizes of the same picture: the texture pipeline picks the one the zoom needs.
      sizes: {
        small: picsum(seed, 160, aspect),
        medium: picsum(seed, 480, aspect),
        large: picsum(seed, 1200, aspect),
      },
      aspect,
      // The flat colour a card shows until its picture lands (a ThumbHash would give a blurred preview).
      color: hslToHex(hue, 0.25, 0.28),
    };
    // About one card in ten is a video.
    const video = rand() < 0.1 ? VIDEOS[Math.floor(rand() * VIDEOS.length)] : undefined;
    out.push({ media: video ? { ...media, video } : media, w: 200 + Math.round(rand() * 100) });
  }
  return out;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Embed cards: a URL (a known provider, or any page) or a snippet of HTML. A card is its poster in WebGL
// and gets a live iframe only when it is big on screen or selected, with the camera still.
const SNIPPET_GRADIENT = `<!doctype html><style>
  html,body{height:100%;margin:0}
  body{background:linear-gradient(120deg,#ff6a88,#ffb36b,#6bd6ff,#9b6bff,#ff6a88);background-size:300% 300%;
    animation:flow 9s ease-in-out infinite;display:grid;place-items:center;
    font:700 28px/1.1 system-ui,sans-serif;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.35);letter-spacing:.02em}
  @keyframes flow{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
</style><body>animated gradient</body>`;

const SNIPPET_COUNTER = `<!doctype html><style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#14161c;color:#e8e8ea;font:15px system-ui,sans-serif}
  main{text-align:center}
  output{display:block;font:700 72px/1 ui-monospace,monospace;margin-bottom:14px}
  button{font:inherit;color:inherit;background:#2a2f3a;border:1px solid #444b5a;border-radius:8px;padding:8px 16px;margin:0 4px;cursor:pointer}
  button:hover{background:#363d4b}
</style><main><output id="n">0</output><button id="dec">-1</button><button id="inc">+1</button></main>
<script>
  let n = 0;
  const out = document.getElementById('n');
  const set = (v) => { n = v; out.textContent = String(n); };
  document.getElementById('inc').onclick = () => set(n + 1);
  document.getElementById('dec').onclick = () => set(n - 1);
</script>`;

const EMBED_W = 480;
const EMBEDS: ElementInit[] = [
  { media: { embed: { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' } } },
  { media: { embed: { url: 'https://youtu.be/aqz-KE-bpKQ' } } },
  { media: { embed: { url: 'https://vimeo.com/76979871' } } },
  { media: { embed: { url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT' } } },
  { media: { embed: { url: 'https://codepen.io/chriscoyier/pen/gfdDu' } } },
  { media: { embed: { url: 'https://en.wikipedia.org/wiki/Moodboard' }, aspect: 0.7 } },
  // github.com refuses framing (X-Frame-Options: deny): the demo resolver says so, and the card is a
  // bookmark. A double-click opens the page in a new tab.
  { media: { embed: { url: 'https://github.com' }, aspect: 0.5 } },
  { media: { embed: { html: SNIPPET_GRADIENT, title: 'Animated gradient' }, aspect: 0.625 }, aspectLocked: false },
  { media: { embed: { html: SNIPPET_COUNTER, title: 'Counter', resolution: 'native' }, aspect: 0.625 }, aspectLocked: false },
];

// What a real host answers from a server: oEmbed titles and thumbnails, og:image, a screenshot, and
// above all whether the page may be framed (X-Frame-Options / CSP frame-ancestors), which a browser
// cannot tell. Here a stub knows one site.
function resolveEmbed(url: string): EmbedInfo | null {
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (host === 'github.com') return { frameable: false, title: 'GitHub: open in a new tab' };
  return null;
}

// Rows of embeds, 480 px wide, above the grid.
function placeEmbeds(board: Corkboard): void {
  const b = board.bounds();
  const gap = 28;
  const perRow = 4;
  const ids = board.add(EMBEDS.map((init) => ({ ...init, x: 0, y: 0, w: EMBED_W })));
  const heights = ids.map((id) => board.get(id)?.h ?? 270);
  const rowHeight = (row: number): number =>
    Math.max(...heights.slice(row * perRow, (row + 1) * perRow));
  const rows = Math.ceil(ids.length / perRow);
  let y = b.y0 - gap;
  for (let r = rows - 1; r >= 0; r--) y -= rowHeight(r) + (r === rows - 1 ? 0 : gap);
  for (let r = 0; r < rows; r++) {
    const count = Math.min(perRow, ids.length - r * perRow);
    for (let c = 0; c < count; c++) {
      board.update(ids[r * perRow + c], { x: b.x0 + c * (EMBED_W + gap), y });
    }
    // A video card takes the free slot at the end of the last row: a clip playing beside the embeds.
    if (r === rows - 1 && count < perRow) {
      board.add({
        media: { src: picsum(9001, 480, 0.5625), video: VIDEOS[2], aspect: 0.5625 },
        x: b.x0 + count * (EMBED_W + gap),
        y,
        w: EMBED_W,
      });
    }
    y += rowHeight(r) + gap;
  }
}

// Windows added so far, so the label numbers and the seed of the next batch differ.
let windowsAdded = 0;

// Embed cards, each its own seeded little page, in a masonry below `y0`. Returns the new ids.
function addWindows(board: Corkboard, n: number, x0: number, y0: number): string[] {
  const seed = 1000 + windowsAdded;
  const inits = makeWindows(n, rng(seed), windowsAdded);
  windowsAdded += n;
  return board.add(placeWindows(inits, x0, y0, rng(seed + 1)));
}

// A wide block reads better than a tall one: columns for roughly a 16:10 grid.
const columnsFor = (n: number): number => Math.max(2, Math.round(Math.sqrt(n * 1.25 * 1.6)));

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// Same breakpoint as the phone layout in style.css.
const NARROW = '(max-width: 719px)';
const STORE = 'corkboard-demo:';

function load(key: string): string | null {
  try {
    return localStorage.getItem(STORE + key);
  } catch {
    return null; // storage can be blocked (private mode, sandboxed frame)
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(STORE + key, value);
  } catch {
    // A choice that is not remembered is not worth an error.
  }
}

let toastTimer = 0;
// One message at a time: a new one replaces the last and restarts the countdown.
function toast(msg: string): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

// Add and Settings share one slot above the toolbar: opening one closes the other. Returns the closer.
function initPopovers(): () => void {
  const dock = $('dock');
  const popovers = [
    { toggle: $('add-toggle'), panel: $('add-popover') },
    { toggle: $('settings-toggle'), panel: $('settings-popover') },
  ];
  const show = (panel: HTMLElement | null): void => {
    for (const p of popovers) {
      const open = p.panel === panel;
      p.panel.hidden = !open;
      p.toggle.setAttribute('aria-expanded', String(open));
    }
    if (panel === $('add-popover')) $('embed-url').focus();
  };
  for (const p of popovers) p.toggle.onclick = () => show(p.panel.hidden ? p.panel : null);
  // Capture phase: the board and the embed field both stop their events before the document sees them.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!dock.contains(e.target as Node)) show(null);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      const open = popovers.find((p) => !p.panel.hidden);
      if (e.key !== 'Escape' || !open) return;
      e.stopPropagation(); // this Escape closes the popover and does nothing else
      show(null);
      open.toggle.focus();
    },
    true,
  );
  return () => show(null);
}

// A panel the user can fold away: `button` shows and hides `body`, and the choice is remembered under `key`.
function foldable(button: HTMLElement, body: HTMLElement, key: string, openByDefault: boolean): void {
  const show = (open: boolean): void => {
    body.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  const saved = load(key);
  show(saved ? saved === 'open' : openByDefault);
  button.onclick = () => {
    const open = body.hidden;
    show(open);
    save(key, open ? 'open' : 'closed');
  };
}

// What people paste is often a bare address ("youtube.com/watch?v=…"): give it https://. Anything that is
// still not an http(s) URL with a dotted host is not a link, and would only make an "invalid URL" card.
function toLink(text: string): string | null {
  const raw = text.trim();
  if (raw === '' || /\s/.test(raw)) return null;
  try {
    // A scheme is letters and a colon, but "example.com:8080" is a host and a port.
    const url = new URL(/^[a-z][a-z\d+.-]*:(?!\d)/i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname !== 'localhost' && !url.hostname.includes('.')) return null;
    return url.href;
  } catch {
    return null;
  }
}

// The board zooms on a pinch (a wheel event with ctrlKey) only over the canvas. Over the floating panels the
// browser would zoom the whole page, chrome included, so that default is turned off there.
function keepPageZoom(host: HTMLElement): void {
  document.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey && !host.contains(e.target as Node)) e.preventDefault();
    },
    { passive: false },
  );
  // Safari pinches with its own gesture events.
  document.addEventListener('gesturestart', (e) => {
    if (!host.contains(e.target as Node)) e.preventDefault();
  });
}

// A segmented control is a radio group: `apply` gets the value of whichever radio was just checked.
function onRadio<T extends string>(name: string, apply: (value: T) => void): void {
  for (const input of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    input.onchange = () => apply(input.value as T);
  }
}

// A small stats panel: the loop parks when nothing moves (rAF/s drops to 0).
function startStats(board: Corkboard): void {
  const stat = (key: string, value: string): void => {
    $(`stat-${key}`).textContent = value;
  };
  let lastRaf = 0;
  let lastT = performance.now();
  setInterval(() => {
    const s = board.stats() as Record<string, number | number[] | Record<string, number>>;
    const now = performance.now();
    const raf = s.rafCalls as number;
    const perSec = Math.round(((raf - lastRaf) / (now - lastT)) * 1000);
    lastRaf = raf;
    lastT = now;
    const lv = s.levelsMounted as number[];
    stat('cards', String(board.size));
    stat('mounted', String(s.mounted));
    stat('zoom', `${Math.round((s.scale as number) * 100)}%`);
    stat('raf', String(perSec));
    stat('tick', `${(s.tickMs as Record<string, number>).p95} ms`);
    stat('textures', `${Math.round((s.textureBytes as number) / 1048576)} MB`);
    stat('lod', lv.join('/'));
    // Clips playing / the cap the frame rate allows now (it drops while the page runs slow).
    const videoCap = board.videoBudget;
    stat('playing', `${board.playing.size}/${Number.isFinite(videoCap) ? videoCap : '∞'}`);
    const max = board.embeds.maxLive;
    stat(
      'embeds',
      `${board.embeds.live.size}/${Number.isFinite(max) ? max : '∞'}${board.embeds.interacting ? ' · interacting' : ''}`,
    );
    stat('parked', String(board.embeds.parked.size));
    stat('culled', String(board.embeds.culled.size));
    stat('frozen', String(board.embeds.frozen.size));
    stat('freeze', `${Math.round(board.embeds.freezeThreshold)} px`);
    const budget = board.embeds.animatingBudget;
    stat('animating', `${board.embeds.animating.size}/${Number.isFinite(budget) ? budget : '∞'}`);
    stat('loading', String(board.embeds.loading.size));
    stat('previews', String(board.embeds.previewsPending));
    stat('selected', String(board.selection.length));
    const state = perSec > 0 ? 'rendering' : 'idle';
    $('stats-state').dataset.state = state;
    $('stats-state-label').textContent = state;
  }, 500);
}

const NO_CAP = {
  maxLive: Number.POSITIVE_INFINITY,
  maxLiveTouch: Number.POSITIVE_INFINITY,
  maxMounted: Number.POSITIVE_INFINITY,
  maxMountedTouch: Number.POSITIVE_INFINITY,
};
// What the windows mode turns on: any card in view goes live, with no cap, and videos play on their own.
const WINDOWS_OPTIONS = { ...NO_CAP, minLivePx: 0, minLiveScale: 0, autoplay: true };

// Makes the settings panel say what WINDOWS_OPTIONS did.
function showWindowsSettings(): void {
  const pick = (name: string, value: string): void => {
    const input = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  };
  pick('golive', 'view');
  pick('maxlive', 'all');
  $<HTMLInputElement>('autoplay').checked = true;
}

async function main(): Promise<void> {
  const closePopovers = initPopovers();
  keepPageZoom($('board'));
  foldable($('stats-toggle'), $('hud'), 'stats', !window.matchMedia(NARROW).matches);
  foldable($('help-toggle'), $('help'), 'help', window.innerWidth >= 1200);
  // The close button only shows while the card is open, so a click on the toggle is a close.
  $('help-close').onclick = () => $('help-toggle').click();

  const board = await Corkboard.create($('board'), {
    theme: 'dark',
    // Times each GPU render, for the GPU chart in the stats panel.
    gpuTimer: true,
    // The library only spends a stream on a card at least 160 px on screen. The demo opens on the whole board,
    // where a card is about 30 px: let the clips play from there (still at most 8 at once).
    video: { mode: 'always', minPlayPx: 24 },
    snapping: { guides: true, grid: false },
    // The windows board starts with everything on: every card in view live, no cap, autoplay.
    // Snippet previews are kept across reloads here (the library default is this page only).
    embeds: WINDOWS > 0 ? { resolve: resolveEmbed, previewCache: 'persistent', ...WINDOWS_OPTIONS } : { resolve: resolveEmbed, previewCache: 'persistent' },
  });
  (window as unknown as { board: Corkboard }).board = board;

  if (WINDOWS > 0) {
    addWindows(board, WINDOWS, 0, 0);
    showWindowsSettings();
  } else {
    board.add(makeCards(COUNT));
    board.layout.tidy(undefined, { columns: columnsFor(COUNT), animate: false });
  }
  placeEmbeds(board);
  board.camera.fit(undefined, { animate: false });

  const targets = (): readonly string[] | undefined => board.arrangeTargets;
  const cols = (): number => columnsFor(targets()?.length ?? board.size);
  const need = (n: number): boolean => {
    if (board.selection.length >= n) return true;
    toast(`Select ${n} or more cards first (Shift+click, or Shift+drag a rectangle on empty canvas).`);
    return false;
  };

  $('tidy').onclick = () => board.layout.tidy(targets(), { columns: cols() });
  $('masonry').onclick = () => board.layout.masonry(targets(), { columns: cols() });
  $('align').onclick = () => need(2) && board.layout.align('left', board.selection);
  $('distribute').onclick = () => need(3) && board.layout.distribute('x', board.selection);
  $('equal').onclick = () => need(2) && board.layout.equalWidth(board.selection);
  $('fit').onclick = () => board.camera.fit();
  const addEmbed = (): void => {
    const input = $<HTMLInputElement>('embed-url');
    const url = toLink(input.value);
    if (url === null) {
      if (input.value.trim() !== '') toast('That is not a link. Paste a web address, like youtube.com/watch?v=…');
      return;
    }
    const [id] = board.add({ media: { embed: { url } } });
    input.value = '';
    board.select([id]);
    board.camera.fit([id], { padding: 160 });
    toast('Embed added. Double-click it (or press Enter) to interact; Done, Esc or a click outside ends it.');
    closePopovers();
  };
  $('add-embed').onclick = addEmbed;
  $<HTMLInputElement>('embed-url').onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') addEmbed();
  };
  $('add').onclick = () => {
    board.add(makeCards(100));
    toast('100 cards added next to what is on screen.');
    closePopovers();
  };
  $('add-windows').onclick = () => {
    const b = board.bounds();
    const ids = addWindows(board, WINDOWS_BUTTON, b.x0, b.y1 + 200);
    board.setEmbeds(WINDOWS_OPTIONS);
    showWindowsSettings();
    board.camera.fit(ids, { padding: 80 });
    toast(`${WINDOWS_BUTTON} windows added, autoplay on, no live cap. Zoom out slowly if it feels heavy.`);
    closePopovers();
  };
  $<HTMLInputElement>('guides').onchange = (e) =>
    board.setSnapping({ guides: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>('gridsnap').onchange = (e) =>
    board.setSnapping({ grid: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>('dots').onchange = (e) =>
    board.setGrid((e.target as HTMLInputElement).checked);
  onRadio<VideoMode>('video', (mode) => board.setVideo({ mode }));
  onRadio<Exclude<EmbedResolution, number>>('resolution', (resolution) => board.setEmbeds({ resolution }));
  // In view: any card on screen (the default). Large: the old 320 x 200 px at zoom >= 0.25. Selected: only
  // the selected card. Parked frames (live once, now small) are not affected.
  onRadio<'view' | 'large' | 'selected'>('golive', (v) =>
    board.setEmbeds(
      v === 'view'
        ? { minLivePx: 0, minLiveScale: 0 }
        : v === 'large'
          ? { minLivePx: 320, minLiveScale: 0.25 }
          : { minLivePx: Number.POSITIVE_INFINITY, minLiveScale: 0 },
    ),
  );
  // Touch gets a quarter of it; parked frames may double it. All: no cap, touch included.
  onRadio<string>('maxlive', (v) => {
    if (v === 'all') {
      board.setEmbeds(NO_CAP);
      return;
    }
    const n = Number(v);
    const touch = Math.max(1, Math.round(n / 4));
    board.setEmbeds({ maxLive: n, maxLiveTouch: touch, maxMounted: n * 2, maxMountedTouch: touch * 2 });
  });
  $<HTMLInputElement>('autoplay').onchange = (e) =>
    board.setEmbeds({ autoplay: (e.target as HTMLInputElement).checked });
  // Lowers how many frames animate while the page is slow, and raises it back when it is smooth.
  $<HTMLInputElement>('adaptive').onchange = (e) =>
    board.setEmbeds({ adaptive: (e.target as HTMLInputElement).checked });
  // The body background follows the `--bg` token, which is the canvas colour of each theme.
  let dark = true;
  $('theme').onclick = () => {
    dark = !dark;
    board.setTheme(dark ? 'dark' : 'light');
    document.body.classList.toggle('light', !dark);
    // The icon swaps in CSS; the label and the tooltip name the action the button now does.
    const action = dark ? 'Switch to light' : 'Switch to dark';
    $('theme').setAttribute('aria-label', action);
    $('theme').dataset.tip = action;
  };

  startStats(board);
  startPerfPanel($('hud'), board);
  board.on('selection', ({ ids }) => {
    if (ids.length > 0) toast(`${ids.length} selected`);
  });
}

void main();
