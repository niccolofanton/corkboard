// The "1000 windows" board: many different cards, generated from a seeded generator so a reload shows the same
// board. ~45% small self-contained HTML snippets (they animate on their own, no network), ~6% YouTube videos,
// ~4% Wikipedia articles, ~35% pictures and ~10% video clips.
import type { ElementInit } from '@niccolofanton/corkboard';

// What a template is parameterised with.
interface Params {
  n: number;
  label: string;
  hue: number;
  hue2: number;
  // 0.6 .. 2: how fast things move.
  speed: number;
  text: string;
  // 3 .. 5: how many of whatever the template repeats.
  count: number;
}

const hsl = (h: number, s: number, l: number): string => `hsl(${Math.round(h) % 360} ${s}% ${l}%)`;
const js = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// Every snippet shares the reset and the corner label; `css` and `body` are the template's own.
function page(p: Params, css: string, body: string, script = ''): string {
  return (
    `<style>html,body{height:100%;margin:0;overflow:hidden}` +
    `body{font:600 14px/1.2 system-ui,sans-serif;color:#fff;background:${hsl(p.hue, 45, 12)}}` +
    `.t{position:absolute;left:8px;top:6px;font:600 11px ui-monospace,monospace;opacity:.6;z-index:2}${css}</style>` +
    `<i class=t>${esc(p.label)}</i>${body}` +
    (script ? `<script>${script}</script>` : '')
  );
}

export const TEMPLATES: readonly { name: string; build: (p: Params) => string }[] = [
  {
    name: 'clock',
    build: (p) =>
      page(
        p,
        `body{display:grid;place-items:center;background:${hsl(p.hue, 50, 14)}}` +
          `#c{font:700 clamp(18px,9vw,56px)/1 ui-monospace,monospace;color:${hsl(p.hue2, 90, 70)};font-variant-numeric:tabular-nums}`,
        `<div id=c></div>`,
        `const e=document.getElementById('c'),o=${js((p.n * 7) % 3600)}*1000;` +
          `(function f(){const d=new Date(Date.now()+o);` +
          `e.textContent=d.toTimeString().slice(0,8)+'.'+String(d.getMilliseconds()).padStart(3,'0');` +
          `requestAnimationFrame(f)})()`,
      ),
  },
  {
    name: 'gradient',
    build: (p) =>
      page(
        p,
        `body{background:linear-gradient(120deg,${hsl(p.hue, 85, 60)},${hsl(p.hue + 50, 85, 62)},${hsl(p.hue2, 85, 58)},${hsl(p.hue, 85, 60)});` +
          `background-size:300% 300%;animation:f ${(12 / p.speed).toFixed(1)}s ease-in-out infinite;display:grid;place-items:center;` +
          `font:700 clamp(16px,7vw,34px)/1.1 system-ui;text-shadow:0 2px 14px rgba(0,0,0,.35);text-align:center;padding:12px;box-sizing:border-box}` +
          `@keyframes f{0%,100%{background-position:0 50%}50%{background-position:100% 50%}}`,
        `<div>${esc(p.text)}</div>`,
      ),
  },
  {
    name: 'bouncing balls',
    build: (p) =>
      page(
        p,
        `.b{position:absolute;border-radius:50%;left:0;top:0;will-change:transform}`,
        '',
        `const B=[];for(let i=0;i<${p.count};i++){const e=document.createElement('div');e.className='b';` +
          `const r=10+i*5;e.style.cssText='width:'+2*r+'px;height:'+2*r+'px;background:hsl('+(${p.hue}+i*${Math.round(p.hue2 % 70) + 20})+' 85% 62%)';` +
          `document.body.append(e);B.push({e,r,x:30+i*40,y:30+i*20,vx:(1.5+i*.7)*${p.speed},vy:(1+i*.9)*${p.speed}})}` +
          `let l=0;(function f(t){const k=l?Math.min(4,(t-l)/16.67):1;l=t;const W=innerWidth,H=innerHeight;for(const b of B){b.x+=b.vx*k;b.y+=b.vy*k;` +
          `if(b.x<0||b.x>W-2*b.r)b.vx*=-1;if(b.y<0||b.y>H-2*b.r)b.vy*=-1;` +
          `b.e.style.transform='translate('+b.x+'px,'+b.y+'px)'}requestAnimationFrame(f)})(0)`,
      ),
  },
  {
    name: 'particles',
    build: (p) =>
      page(
        p,
        `canvas{position:absolute;inset:0;width:100%;height:100%}`,
        `<canvas id=c></canvas>`,
        `const c=document.getElementById('c'),g=c.getContext('2d');let W,H;` +
          `function rs(){W=c.width=innerWidth;H=c.height=innerHeight}rs();addEventListener('resize',rs);` +
          `const P=Array.from({length:${24 + p.count * 8}},(_,i)=>({x:Math.random()*W,y:Math.random()*H,a:Math.random()*6.28,s:(.5+Math.random())*${p.speed},h:${p.hue}+i*${(p.hue2 % 5) + 2}}));` +
          `let l=0;(function f(t){const k=l?Math.min(4,(t-l)/16.67):1;l=t;g.fillStyle='rgba(0,0,0,'+(1-Math.pow(.88,k))+')';g.fillRect(0,0,W,H);` +
          `for(const q of P){q.a+=(Math.random()-.5)*.3*Math.sqrt(k);q.x=(q.x+Math.cos(q.a)*q.s*2*k+W)%W;q.y=(q.y+Math.sin(q.a)*q.s*2*k+H)%H;` +
          `g.fillStyle='hsl('+q.h+' 90% 65%)';g.beginPath();g.arc(q.x,q.y,2.2,0,6.28);g.fill()}requestAnimationFrame(f)})(0)`,
      ),
  },
  {
    name: 'spinning shapes',
    build: (p) => {
      const shapes = Array.from({ length: p.count }, (_, i) => {
        const size = 28 + i * 16;
        const radius = i % 2 === 0 ? '12%' : '50%';
        const dur = ((6 + i * 2) / p.speed).toFixed(1);
        return (
          `<b style="width:${size}%;height:${size}%;border-radius:${radius};border:3px solid ${hsl(p.hue + i * 38, 85, 65)};` +
          `animation:s ${dur}s linear infinite${i % 2 ? ' reverse' : ''}"></b>`
        );
      }).join('');
      return page(
        p,
        `body{display:grid;place-items:center}b{position:absolute;aspect-ratio:1;box-sizing:border-box;left:50%;top:50%;margin:0}` +
          `@keyframes s{from{transform:translate(-50%,-50%) rotate(0)}to{transform:translate(-50%,-50%) rotate(360deg)}}`,
        shapes,
      );
    },
  },
  {
    name: 'ticker',
    build: (p) => {
      const row = (i: number): string =>
        `<div class=r style="top:${22 + i * 26}%;color:${hsl(p.hue + i * 60, 80, 72)};` +
        `animation-duration:${((14 + i * 5) / p.speed).toFixed(1)}s;animation-direction:${i % 2 ? 'reverse' : 'normal'}">` +
        `${esc((p.text + '  ·  ').repeat(6))}</div>`;
      return page(
        p,
        `.r{position:absolute;left:0;white-space:nowrap;font:700 clamp(16px,6vw,30px)/1 system-ui;animation:m linear infinite}` +
          `@keyframes m{from{transform:translateX(0)}to{transform:translateX(-50%)}}`,
        [0, 1, 2].map(row).join(''),
      );
    },
  },
  {
    name: 'counter',
    build: (p) =>
      page(
        p,
        `body{display:grid;place-items:center;text-align:center}` +
          `output{display:block;font:700 clamp(30px,14vw,76px)/1 ui-monospace,monospace;color:${hsl(p.hue2, 85, 70)};margin-bottom:10px}` +
          `button{font:inherit;color:inherit;background:${hsl(p.hue, 30, 24)};border:1px solid ${hsl(p.hue, 30, 38)};border-radius:8px;padding:6px 14px;margin:0 3px;cursor:pointer}`,
        `<main><output id=n>0</output><button id=d>-1</button><button id=i>+1</button></main>`,
        `let n=${p.n % 100};const o=document.getElementById('n'),s=v=>{n=v;o.textContent=n};s(n);` +
          `document.getElementById('i').onclick=()=>s(n+1);document.getElementById('d').onclick=()=>s(n-1);` +
          `setInterval(()=>s(n+1),${Math.round(1000 / p.speed)})`,
      ),
  },
  {
    name: 'chart',
    build: (p) =>
      page(
        p,
        `body{display:flex;align-items:flex-end;gap:3%;padding:30px 5% 6%;box-sizing:border-box}` +
          `.c{flex:1;border-radius:3px 3px 0 0;transition:height ${(0.5 / p.speed).toFixed(2)}s ease;background:${hsl(p.hue2, 80, 60)}}` +
          `.c:nth-child(odd){background:${hsl(p.hue, 80, 62)}}`,
        '',
        `const K=${6 + p.count * 2},C=[];for(let i=0;i<K;i++){const e=document.createElement('div');e.className='c';document.body.append(e);C.push(e)}` +
          `let v=Array.from({length:K},()=>.3+Math.random()*.6);` +
          `(function t(){v=v.map(x=>Math.min(.95,Math.max(.1,x+(Math.random()-.5)*.35)));` +
          `C.forEach((e,i)=>e.style.height=v[i]*100+'%');setTimeout(t,${Math.round(700 / p.speed)})})()`,
      ),
  },
  {
    name: 'typewriter',
    build: (p) =>
      page(
        p,
        `body{display:grid;place-items:center;padding:16px;box-sizing:border-box;background:${hsl(p.hue, 40, 10)}}` +
          `#w{font:600 clamp(14px,5vw,26px)/1.3 ui-monospace,monospace;color:${hsl(p.hue2, 85, 72)};word-break:break-word}` +
          `#w::after{content:'';display:inline-block;width:.5em;height:1em;margin-left:2px;vertical-align:-.12em;background:currentColor;animation:k 1s steps(1) infinite}` +
          `@keyframes k{50%{opacity:0}}`,
        `<div id=w></div>`,
        `const T=${js(p.text)},w=document.getElementById('w');let i=0;` +
          `(function f(){w.firstChild&&w.firstChild.remove();w.prepend(T.slice(0,i));i=i>=T.length+12?0:i+1;setTimeout(f,${Math.round(110 / p.speed)})})()`,
      ),
  },
];

const WORDS = [
  'sunrise', 'paper', 'orbit', 'signal', 'velvet', 'harbor', 'static', 'mosaic', 'lantern', 'echo',
  'ember', 'glacier', 'neon', 'meadow', 'prism', 'cobalt', 'drift', 'atlas', 'fable', 'quartz',
  'ripple', 'saffron', 'tundra', 'violet', 'zenith', 'amber', 'bloom', 'comet', 'delta', 'ferry',
];

// height / width: 16:9, 4:3, 1:1, 3:4, 21:9.
const ASPECTS = [9 / 16, 3 / 4, 1, 4 / 3, 9 / 21];

// Public, embeddable, long-lived YouTube videos (each one answers the oEmbed endpoint with 200).
export const YOUTUBE_IDS: readonly string[] = [
  'aqz-KE-bpKQ', // Big Buck Bunny
  'jNQXAC9IVRw', // Me at the zoo
  'eRsGyueVLvQ', // Sintel
  'R6MlUcmOul8', // Tears of Steel
  'TLkA0RELQ1g', // Elephants Dream
  'M7lc1UVf-VE', // YouTube Developers Live: Embedded Web Player Customization
  'YE7VzlLtp-4', // Big Buck Bunny (another upload)
  'dQw4w9WgXcQ',
  '9bZkp7q19f0',
  'kJQP7kiw5Fk',
  'JGwWNGJdvx8',
  'OPf0YbXqDm0',
  'RgKAFK5djSk',
  '60ItHLz5WEA',
  'hT_nvWreIhg',
  'CevxZvSJLk8',
  'YQHsXMglC9A',
  'pRpeEdMmmQ0',
  'ZbZSe6N_BXs',
  'e-ORhEE9VVg',
  'kXYiU_JCYtU',
  '7wtfhZwyrcc',
  'YykjpeuMNEk',
  'VYOjWnS4cMY',
  'hLQl3WQQoQ0',
  '8UVNT4wvIGY',
];

export const WIKI_TITLES: readonly string[] = [
  'Alan_Turing', 'Aurora', 'Bauhaus', 'Black_hole', 'Bonsai', 'Brutalist_architecture', 'Coral_reef',
  'Cartography', 'Origami', 'Octopus', 'Mount_Fuji', 'Jazz', 'Impressionism', 'Typography', 'Volcano',
  'Great_Barrier_Reef', 'Giza_pyramid_complex', 'Saturn', 'Tardigrade', 'Sourdough', 'Skateboarding',
  'Synthesizer', 'Submarine', 'Kyoto', 'Lighthouse', 'Fibonacci_sequence', 'Mandelbrot_set',
  'Periodic_table', 'Eiffel_Tower', 'Amazon_rainforest', 'Honey_bee', 'Chess', 'Telescope', 'Glacier',
  'Hot_air_balloon', 'Ukiyo-e', 'Art_Nouveau', 'Marie_Curie', 'Printing_press', 'Kaleidoscope',
];

const pick = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)];

// `n` embed cards (no position or width yet; see `placeWindows`), numbered from `start`. All the randomness
// comes from `rand`.
// Public sample clips served with CORS: the poster is a picsum picture, the clip plays in a <video> overlay.
const CLIPS = [
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4',
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
];
const PHOTO_ASPECTS = [1.5, 1.25, 1, 0.75, 0.66, 0.5625];

const picsum = (seed: number, w: number, aspect: number): string =>
  `https://picsum.photos/seed/w${seed}/${w}/${Math.round(w * aspect)}`;

// A picture with the three renditions the texture pipeline picks from.
function photo(seed: number, aspect: number) {
  return {
    src: picsum(seed, 480, aspect),
    sizes: { small: picsum(seed, 160, aspect), medium: picsum(seed, 480, aspect), large: picsum(seed, 1200, aspect) },
    aspect,
  };
}

// The mix of a windows board: live HTML windows, provider embeds, pictures and video clips.
const MIX = { snippet: 0.45, youtube: 0.51, wiki: 0.55, image: 0.9 }; // cumulative; the rest are videos

// One live HTML window: a random template with its own palette, speed and text. No poster: the layer draws
// a tile from the title until it goes live.
export function makeSnippet(rand: () => number, n: number, label: string): ElementInit {
  const hue = Math.floor(rand() * 360);
  const p: Params = {
    n,
    label,
    hue,
    hue2: (hue + 60 + Math.floor(rand() * 180)) % 360,
    speed: 0.6 + rand() * 1.4,
    text: `${pick(rand, WORDS)} ${pick(rand, WORDS)} ${pick(rand, WORDS)}`,
    count: 3 + Math.floor(rand() * 3),
  };
  const html = pick(rand, TEMPLATES).build(p);
  return { media: { embed: { html, title: label }, aspect: pick(rand, ASPECTS) }, aspectLocked: false };
}

export function makeWindows(n: number, rand: () => number, start = 0): ElementInit[] {
  const out: ElementInit[] = [];
  // Walk the lists in a shuffled order so the same video or article is as far apart as it can be.
  let yt = Math.floor(rand() * YOUTUBE_IDS.length);
  let wiki = Math.floor(rand() * WIKI_TITLES.length);
  for (let i = 0; i < n; i++) {
    const label = `Window #${String(start + i).padStart(4, '0')}`;
    const kind = rand();
    if (kind < MIX.snippet) {
      out.push(makeSnippet(rand, start + i, label));
    } else if (kind < MIX.youtube) {
      // A start time apart, so the same video is not the same frame twice.
      const id = YOUTUBE_IDS[yt++ % YOUTUBE_IDS.length];
      const t = 5 + Math.floor(rand() * 180);
      out.push({ media: { embed: { url: `https://www.youtube.com/watch?v=${id}&t=${t}`, title: label } } });
    } else if (kind < MIX.wiki) {
      const title = WIKI_TITLES[wiki++ % WIKI_TITLES.length];
      out.push({ media: { embed: { url: `https://en.wikipedia.org/wiki/${title}`, title: label }, aspect: 0.7 } });
    } else if (kind < MIX.image) {
      out.push({ media: photo(start + i, pick(rand, PHOTO_ASPECTS)) });
    } else {
      out.push({ media: { ...photo(start + i, 0.5625), video: pick(rand, CLIPS) } });
    }
  }
  return out;
}

// A masonry of columns, 24 px apart, from (x0, y0) to the right and down. Each column has one width (360 to
// 480 px) and each card goes to the shortest column. The rows below (embeds, video) stay out of the way: the
// caller passes the origin.
export function placeWindows(inits: ElementInit[], x0: number, y0: number, rand: () => number): ElementInit[] {
  const GAP = 24;
  const cols = Math.max(2, Math.round(Math.sqrt((inits.length * 1.6) / 0.85)));
  const widths = Array.from({ length: cols }, () => 360 + Math.round(rand() * 120));
  const xs: number[] = [];
  let x = x0;
  for (const w of widths) {
    xs.push(x);
    x += w + GAP;
  }
  const bottoms = new Array<number>(cols).fill(y0);
  return inits.map((init) => {
    let c = 0;
    for (let i = 1; i < cols; i++) if (bottoms[i] < bottoms[c]) c = i;
    const w = widths[c];
    const aspect = init.media.aspect ?? 9 / 16;
    const y = bottoms[c];
    bottoms[c] += Math.round(w * aspect) + GAP;
    return { ...init, x: xs[c], y, w };
  });
}
