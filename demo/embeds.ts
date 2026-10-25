// A focused repro page for two embed bugs:
//   1. Stretched previews: an embed card's poster is drawn stretched when its aspect differs from the card's.
//   2. Embeds vanish too early: a live iframe is swapped for the poster while it is still plainly visible.
// Only the public API is used, so the page works against any version of the library.
import { Corkboard, type ElementInit, type EmbedInfo } from '@niccolofanton/corkboard';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── Posters drawn at startup ─────────────────────────────────────────────────

// A poster with a grid, concentric circles, corner circles and its own label: any stretching shows at once.
function circlesPoster(w: number, h: number, label: string, hue: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = `hsl(${hue} 55% 28%)`;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 2;
  const step = Math.min(w, h) / 8;
  for (let x = 0; x <= w; x += step) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  const r = Math.min(w, h);
  g.lineWidth = Math.max(3, r / 60);
  for (let i = 4; i >= 1; i--) {
    g.beginPath();
    g.arc(w / 2, h / 2, (r * i) / 9, 0, Math.PI * 2);
    g.fillStyle = i % 2 ? `hsl(${hue + 40} 80% 62%)` : `hsl(${hue} 60% 22%)`;
    g.fill();
    g.strokeStyle = '#fff';
    g.stroke();
  }
  for (const [x, y] of [[0.1, 0.12], [0.9, 0.12], [0.1, 0.88], [0.9, 0.88]] as const) {
    g.beginPath();
    g.arc(w * x, h * y, r / 14, 0, Math.PI * 2);
    g.fillStyle = '#fff';
    g.fill();
  }
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 ${Math.round(r / 7)}px system-ui, sans-serif`;
  g.shadowColor = '#000';
  g.shadowBlur = 8;
  g.fillText(label, w / 2, h / 2);
  g.font = `600 ${Math.round(r / 16)}px system-ui, sans-serif`;
  g.fillText(`${w}x${h}`, w / 2, h / 2 + r / 7);
  return c.toDataURL('image/png');
}

// The poster of the live snippets: same 16:9 as the card, so only the swap itself is visible.
function greyPoster(w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#6c6c6c';
  g.lineWidth = 6;
  g.strokeRect(3, 3, w - 6, h - 6);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(w, h);
  g.moveTo(w, 0);
  g.lineTo(0, h);
  g.stroke();
  g.fillStyle = '#fff';
  g.fillRect(w * 0.1, h * 0.38, w * 0.8, h * 0.24);
  g.fillStyle = '#333';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 ${Math.round(h / 9)}px system-ui, sans-serif`;
  g.fillText('POSTER (static preview)', w / 2, h / 2);
  return c.toDataURL('image/png');
}

// A group banner, a locked image card.
function banner(text: string, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2d3342';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffd54a';
  g.textBaseline = 'middle';
  g.font = `800 ${Math.round(h * 0.5)}px system-ui, sans-serif`;
  g.fillText(text, h * 0.4, h / 2);
  return c.toDataURL('image/png');
}

// ── Snippets ─────────────────────────────────────────────────────────────────

const BASE_CSS = `html,body{height:100%;margin:0;overflow:hidden}`;

const SNIPPET_STATIC = `<!doctype html><style>${BASE_CSS}
  body{display:grid;place-items:center;background:#0b6b3a;color:#fff;font:800 40px system-ui,sans-serif}
</style><body>LIVE IFRAME</body>`;

const SNIPPET_CLOCK = `<!doctype html><style>${BASE_CSS}
  body{display:grid;place-items:center;background:#101820;color:#7dff9c;font-family:ui-monospace,Menlo,monospace;text-align:center}
  #t{font-size:64px;font-weight:800;line-height:1} #f{font-size:30px;margin-top:10px;color:#ffd54a} small{display:block;margin-top:8px;color:#9ab;font-size:16px}
</style><body><div><div id="t">--:--:--.---</div><div id="f">frame 0</div><small>LIVE iframe (clock)</small></div>
<script>
  const t=document.getElementById('t'),f=document.getElementById('f');let n=0;
  const p=(v,l)=>String(v).padStart(l,'0');
  (function tick(){const d=new Date();t.textContent=p(d.getHours(),2)+':'+p(d.getMinutes(),2)+':'+p(d.getSeconds(),2)+'.'+p(d.getMilliseconds(),3);f.textContent='frame '+(++n);requestAnimationFrame(tick)})();
</script>`;

const SNIPPET_GRADIENT = `<!doctype html><style>${BASE_CSS}
  body{background:linear-gradient(120deg,#ff6a88,#ffb36b,#6bd6ff,#9b6bff,#ff6a88);background-size:300% 300%;
    animation:flow 4s ease-in-out infinite;display:grid;place-items:center;
    font:800 34px/1.1 system-ui,sans-serif;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.4);text-align:center}
  @keyframes flow{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
</style><body>LIVE iframe<br>(moving gradient)</body>`;

const SNIPPET_BALL = `<!doctype html><style>${BASE_CSS}
  body{background:#1c1530} canvas{display:block;width:100%;height:100%}
  p{position:absolute;left:0;right:0;top:8px;margin:0;text-align:center;color:#fff;font:700 18px system-ui,sans-serif}
</style><body><canvas id="c"></canvas><p>LIVE iframe (bouncing ball)</p>
<script>
  const c=document.getElementById('c'),g=c.getContext('2d');
  let x=60,y=60,vx=3.2,vy=2.4;
  (function loop(){
    const w=c.width=c.clientWidth,h=c.height=c.clientHeight;
    x+=vx;y+=vy;if(x<30||x>w-30)vx=-vx;if(y<30||y>h-30)vy=-vy;
    g.fillStyle='#ff4d6d';g.beginPath();g.arc(x,y,30,0,7);g.fill();
    g.fillStyle='#fff';g.beginPath();g.arc(x-9,y-9,8,0,7);g.fill();
    requestAnimationFrame(loop);
  })();
</script>`;

const SNIPPET_COUNTER = `<!doctype html><style>${BASE_CSS}
  body{display:grid;place-items:center;background:#14161c;color:#e8e8ea;font:15px system-ui,sans-serif}
  main{text-align:center}
  output{display:block;font:700 72px/1 ui-monospace,monospace;margin-bottom:14px}
  button{font:inherit;color:inherit;background:#2a2f3a;border:1px solid #444b5a;border-radius:8px;padding:8px 16px;margin:0 4px;cursor:pointer}
</style><main><output id="n">0</output><button id="dec">-1</button><button id="inc">+1</button></main>
<script>
  let n = 0;
  const out = document.getElementById('n');
  const set = (v) => { n = v; out.textContent = String(n); };
  document.getElementById('inc').onclick = () => set(n + 1);
  document.getElementById('dec').onclick = () => set(n - 1);
</script>`;

const SNIPPET_SPINNER = `<!doctype html><style>${BASE_CSS}
  body{display:grid;place-items:center;background:#f4efe6;font:800 24px system-ui,sans-serif;color:#222;text-align:center}
  i{display:block;width:110px;height:110px;margin:0 auto 14px;border-radius:50%;border:14px solid #ddd;border-top-color:#e4572e;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style><body><div><i></i>LIVE iframe (spinner)</div></body>`;

// ── Cards ────────────────────────────────────────────────────────────────────

// What a real host answers from a server: a poster for the URL. Here a wide one, whatever the card's shape.
const WIDE_POSTER = circlesPoster(1200, 500, 'wide poster (12:5)', 200);
function resolveEmbed(url: string): EmbedInfo | null {
  if (url.includes('wikipedia.org/wiki/Circle')) return { poster: WIDE_POSTER, title: 'Circle (resolver poster)' };
  return null;
}

const W2 = 480; // group 2 card width, world px
const H2 = 270; // 16:9

interface Group {
  ids: string[];
}
const group1: Group = { ids: [] };
const group2: Group = { ids: [] };

function addGroup(board: Corkboard, group: Group, inits: ElementInit[]): string[] {
  const ids = board.add(inits);
  group.ids.push(...ids);
  return ids;
}

function build(board: Corkboard): void {
  const G1_Y = 0;
  const G2_Y = 1100;
  const GAP = 60;
  const BANNER_H = 90;

  // Group 1: stretched previews. Each card's shape differs from its poster's on purpose.
  addGroup(board, group1, [
    {
      media: { src: banner('1 · Stretched previews', 1400, 120), aspect: 120 / 1400 },
      x: 0, y: G1_Y - BANNER_H - 40, w: 1400, h: BANNER_H, locked: true,
    },
  ]);
  let x = 0;
  const place = (init: ElementInit, w: number, h: number): void => {
    addGroup(board, group1, [{ ...init, x, y: G1_Y, w, h, aspectLocked: false }]);
    x += w + GAP;
  };
  // (a) tall HTML snippet card (h/w 1.4), wide 16:9 poster
  place(
    {
      media: {
        src: circlesPoster(1280, 720, '16:9 poster', 10),
        embed: { html: SNIPPET_STATIC, title: '(a) tall card, 16:9 poster' },
        aspect: 1.4,
      },
    },
    360,
    504,
  );
  // (b) very wide HTML snippet card (0.35), square poster
  place(
    {
      media: {
        src: circlesPoster(800, 800, '1:1 poster', 120),
        embed: { html: SNIPPET_STATIC, title: '(b) very wide card, square poster' },
        aspect: 0.35,
      },
    },
    640,
    224,
  );
  // (c) URL embed (0.7) whose resolver returns a wide poster
  place({ media: { embed: { url: 'https://en.wikipedia.org/wiki/Circle' }, aspect: 0.7 } }, 420, 294);
  // (d) YouTube, aspect unlocked, resized to a tall shape
  const [yt] = addGroup(board, group1, [
    {
      media: { embed: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' } },
      x, y: G1_Y, w: W2, aspectLocked: false,
    },
  ]);
  board.update(yt, { w: 300, h: 480, aspectLocked: false });

  // Group 2: live embeds with a clearly different static poster.
  addGroup(board, group2, [
    {
      media: { src: banner('2 · Live embeds', 1400, 120), aspect: 120 / 1400 },
      x: 0, y: G2_Y - BANNER_H - 40, w: 1400, h: BANNER_H, locked: true,
    },
  ]);
  const poster = greyPoster(960, 540);
  const snippets: [string, string, string?][] = [
    ['Clock', SNIPPET_CLOCK],
    ['Gradient', SNIPPET_GRADIENT],
    ['Bouncing ball', SNIPPET_BALL],
    ['Counter', SNIPPET_COUNTER, 'native'],
    ['Spinner', SNIPPET_SPINNER],
  ];
  const cards: ElementInit[] = snippets.map(([title, html, resolution]) => ({
    media: {
      src: poster,
      embed: { html, title, ...(resolution ? { resolution: resolution as 'native' } : {}) },
      aspect: H2 / W2,
    },
    w: W2,
    h: H2,
  }));
  cards.push({ media: { embed: { url: 'https://youtu.be/aqz-KE-bpKQ' }, aspect: H2 / W2 }, w: W2, h: H2 });
  cards.forEach((c, i) => {
    c.x = (i % 3) * (W2 + 40);
    c.y = G2_Y + Math.floor(i / 3) * (H2 + 40);
  });
  addGroup(board, group2, cards);
}

// ── HUD ──────────────────────────────────────────────────────────────────────

// `board.embeds.parked` exists only in newer versions of the library: read it defensively.
function parkedCount(board: Corkboard): string {
  const p = (board.embeds as unknown as { parked?: unknown }).parked;
  if (p === undefined || p === null) return 'n/a';
  if (typeof p === 'number') return String(p);
  if (typeof p === 'function') return 'n/a';
  const size = (p as { size?: unknown }).size;
  if (typeof size === 'number') return String(size);
  const len = (p as { length?: unknown }).length;
  return typeof len === 'number' ? String(len) : 'n/a';
}

// Fits a group in the view, leaving the HUD's strip on the left free.
function fitGroup(board: Corkboard, group: Group, animate: boolean): void {
  const els = group.ids.map((id) => board.get(id)).filter((e) => e !== undefined);
  const x0 = Math.min(...els.map((e) => e.x));
  const y0 = Math.min(...els.map((e) => e.y));
  const x1 = Math.max(...els.map((e) => e.x + e.w));
  const y1 = Math.max(...els.map((e) => e.y + e.h));
  const hud = 330;
  const pad = 24;
  const avail = Math.max(200, window.innerWidth - hud - pad);
  const scale = Math.min((window.innerHeight - 2 * pad) / (y1 - y0), avail / (x1 - x0));
  // The rect grows to the left by the HUD's width, in world px, so the group sits right of the panel.
  board.camera.zoomTo({ x0: x0 - hud / scale, y0, x1, y1 }, { animate, padding: pad });
}

async function main(): Promise<void> {
  $('label').textContent = new URLSearchParams(location.search).get('label') || 'Embed test';

  const board = await Corkboard.create($('board'), {
    theme: 'dark',
    embeds: { resolve: resolveEmbed },
  });
  (window as unknown as { board: Corkboard }).board = board;
  build(board);

  // Fit on group 2 first (iframes go live); the camera is still once it is set, so no animation.
  fitGroup(board, group2, false);

  const lines: string[] = [];
  const t0 = performance.now();
  let destroyed = 0;
  board.on('embedLive', ({ id, live }) => {
    if (!live) destroyed++;
    lines.push(`${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s ${live ? 'MOUNT  ' : 'DESTROY'} ${id.slice(0, 8)}`);
    if (lines.length > 5) lines.shift();
  });

  const zoomAbout = (scale: number): void => {
    const v = board.camera.visible();
    board.camera.center((v.x0 + v.x1) / 2, (v.y0 + v.y1) / 2, scale);
  };
  $('g1').onclick = () => fitGroup(board, group1, true);
  $('g2').onclick = () => fitGroup(board, group2, true);
  $('z100').onclick = () => zoomAbout(1);
  // 480-px cards at 200 CSS px wide, under the live threshold of 320x200.
  $('z200').onclick = () => zoomAbout(200 / W2);
  $('z02').onclick = () => zoomAbout(0.2);
  const posters = $<HTMLButtonElement>('posters');
  posters.onclick = () => {
    const on = posters.getAttribute('aria-pressed') !== 'true';
    posters.setAttribute('aria-pressed', String(on));
    posters.textContent = on ? 'Posters only: ON' : 'Posters only';
    // 0 live iframes at once: every embed card stays a poster.
    // maxMounted: parked frames would cover the posters (ignored by builds that have no parking).
    board.setEmbeds(
      (on
        ? { maxLive: 0, maxLiveTouch: 0, maxMounted: 0, maxMountedTouch: 0 }
        : { maxLive: 12, maxLiveTouch: 3, maxMounted: 24, maxMountedTouch: 6 }) as Parameters<typeof board.setEmbeds>[0],
    );
  };

  setInterval(() => {
    $('s-live').textContent = `${board.embeds.live.size} / ${board.embeds.maxLive}`;
    $('s-parked').textContent = parkedCount(board);
    // Absent in builds without the loading indicator.
    const loading = (board.embeds as { loading?: ReadonlySet<string> }).loading;
    $('s-loading').textContent = loading ? String(loading.size) : 'n/a';
    // The same for the states later builds added: culled (off screen), frozen (snapshot), the animating budget.
    const e = board.embeds as { culled?: ReadonlySet<string>; frozen?: ReadonlySet<string>; animating?: ReadonlySet<string>; animatingBudget?: number };
    $('s-culled').textContent = e.culled ? String(e.culled.size) : 'n/a';
    $('s-frozen').textContent = e.frozen ? String(e.frozen.size) : 'n/a';
    $('s-animating').textContent = e.animating
      ? `${e.animating.size} / ${e.animatingBudget === Infinity ? '∞' : String(e.animatingBudget)}`
      : 'n/a';
    // Snippet previews, in builds that have them.
    const pending = (board.embeds as { previewsPending?: number }).previewsPending;
    $('s-previews').textContent = pending === undefined ? 'n/a' : String(pending);
    $('s-destroyed').textContent = String(destroyed);
    $('s-zoom').textContent = `${Math.round(board.camera.get().scale * 100)}%`;
    $('log').textContent = lines.join('\n');
  }, 150);
}

void main();
