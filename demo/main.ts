import { Corkboard, type ElementInit } from 'corkboard';

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

// A wide block reads better than a tall one: columns for roughly a 16:10 grid.
const columnsFor = (n: number): number => Math.max(2, Math.round(Math.sqrt(n * 1.25 * 1.6)));

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function main(): Promise<void> {
  const board = await Corkboard.create($('board'), {
    theme: 'dark',
    video: { mode: 'always' },
    snapping: { guides: true, grid: false },
  });
  (window as unknown as { board: Corkboard }).board = board;

  board.add(makeCards(COUNT));
  board.layout.tidy(undefined, { columns: columnsFor(COUNT), animate: false });
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
      `textures ${Math.round((s.textureBytes as number) / 1048576)} MB · LOD L0-L3 ${lv.join('/')} · playing ${board.playing.size}`;
  }, 500);
  board.on('selection', ({ ids }) => {
    if (ids.length > 0) $('hint').textContent = `${ids.length} selected`;
  });
}

void main();
