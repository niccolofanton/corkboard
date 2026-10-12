import { Corkboard, type ElementInit, type EmbedInfo } from 'corkboard';

const COUNT = 600;
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

function makeCards(n: number): ElementInit[] {
  const out: ElementInit[] = [];
  for (let i = 0; i < n; i++) {
    const seed = nextSeed++;
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
  { media: { embed: { html: SNIPPET_COUNTER, title: 'Counter' }, aspect: 0.625 }, aspectLocked: false },
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

// A wide block reads better than a tall one: columns for roughly a 16:10 grid.
const columnsFor = (n: number): number => Math.max(2, Math.round(Math.sqrt(n * 1.25 * 1.6)));

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function main(): Promise<void> {
  const board = await Corkboard.create($('board'), {
    theme: 'dark',
    video: { mode: 'always' },
    snapping: { guides: true, grid: false },
    embeds: { resolve: resolveEmbed },
  });
  (window as unknown as { board: Corkboard }).board = board;

  board.add(makeCards(COUNT));
  board.layout.tidy(undefined, { columns: columnsFor(COUNT), animate: false });
  placeEmbeds(board);
  board.camera.fit(undefined, { animate: false });

  const targets = (): readonly string[] | undefined => board.arrangeTargets;
  const cols = (): number => columnsFor(targets()?.length ?? board.size);
  const need = (n: number): boolean => {
    if (board.selection.length >= n) return true;
    $('hint').textContent = `Select ${n} or more cards first (Shift+click, or Shift+drag a rectangle on empty canvas).`;
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
    const url = input.value.trim();
    if (url === '') return;
    const [id] = board.add({ media: { embed: { url } } });
    input.value = '';
    board.select([id]);
    board.camera.fit([id], { padding: 160 });
    $('hint').textContent = 'Embed added. Double-click it (or press Enter) to interact; Done, Esc or a click outside ends it.';
  };
  $('add-embed').onclick = addEmbed;
  $<HTMLInputElement>('embed-url').onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') addEmbed();
  };
  $('add').onclick = () => {
    board.add(makeCards(100));
    $('hint').textContent = '100 cards added next to what is on screen.';
  };
  $<HTMLInputElement>('guides').onchange = (e) =>
    board.setSnapping({ guides: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>('gridsnap').onchange = (e) =>
    board.setSnapping({ grid: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>('dots').onchange = (e) =>
    board.setGrid((e.target as HTMLInputElement).checked);
  $<HTMLSelectElement>('video').onchange = (e) =>
    board.setVideo({ mode: (e.target as HTMLSelectElement).value as 'always' | 'hover' | 'off' });
  let dark = true;
  $('theme').onclick = () => {
    dark = !dark;
    board.setTheme(dark ? 'dark' : 'light');
    document.body.classList.toggle('light', !dark);
    document.body.style.background = dark ? '#0f0f0f' : '#f4f4f2';
    $('theme').textContent = dark ? 'Light' : 'Dark';
  };

  // A small stats panel: the loop parks when nothing moves (rAF/s drops to 0).
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
    $('hud').textContent =
      `${board.size} cards · ${s.mounted} mounted · zoom ${Math.round((s.scale as number) * 100)}%\n` +
      `rAF/s ${perSec} · tick p95 ${(s.tickMs as Record<string, number>).p95} ms\n` +
      `textures ${Math.round((s.textureBytes as number) / 1048576)} MB · LOD L0-L3 ${lv.join('/')} · playing ${board.playing.size}\n` +
      `embeds live ${board.embeds.live.size}/${board.embeds.maxLive}${board.embeds.interacting ? ' · interacting' : ''}`;
  }, 500);
  board.on('selection', ({ ids }) => {
    if (ids.length > 0) $('hint').textContent = `${ids.length} selected`;
  });
}

void main();
