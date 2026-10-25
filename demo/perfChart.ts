// Live performance tiles for the stats panel: frame rate, main-thread load, GPU time and texture memory,
// each a current value over a 30-second chart: sampled four times a second, scrolled every frame. What a page can measure about
// itself, labelled as such:
//   FPS   frames this page showed in the last second (requestAnimationFrame).
//   CPU   share of the main thread that was not idle (requestIdleCallback idle time); n/a without it.
//   GPU   time the GPU spent per render of the board's WebGL canvas (the board's `gpuTimer`), not on the
//         browser's compositing of iframes and videos; "idle" while the board draws nothing; n/a where the
//         timer query is unsupported.
//   VRAM  the board's own textures, not the GPU memory of the whole page.
import type { Corkboard } from 'corkboard';

const STEP_MS = 250;
const WINDOW_MS = 30_000;
const SAMPLES = WINDOW_MS / STEP_MS + 2; // a point just past each edge, so the line runs off the chart
const STYLE = `
#hud{max-height:calc(100dvh - var(--t) - var(--b) - 120px);overflow-y:auto}
.perf{grid-column:1/-1;display:grid;gap:10px;margin-top:10px}
.perf-tile{display:grid;grid-template-columns:1fr auto;align-items:baseline;row-gap:4px}
.perf-name{color:var(--muted-fg)}
.perf-value{color:var(--fg);font-variant-numeric:tabular-nums}
.perf-tile canvas{grid-column:1/-1;width:100%;height:44px;display:block;cursor:crosshair}
`;

interface Series {
  unit: string;
  digits: number;
  // The y axis tops at least this; a dashed reference line is drawn at `ref`.
  floor: number;
  ref?: number;
  // What a missing value reads as.
  none: string;
  values: (number | null)[];
  // When each value was taken (performance.now()): x is placed by time, so the chart scrolls between samples.
  times: number[];
  value: HTMLElement;
  canvas: HTMLCanvasElement;
  // The pointer's x on the chart, 0..1 (null: not over it).
  hover: number | null;
}

// The board's per-render GPU times since the last read (ms), from its timer ring. `stats()` only reports
// percentiles over its whole history, and a live chart needs the latest moments.
function gpuSince(board: Corkboard, cursor: { n: number }): number[] {
  const s = board.stage as unknown as { gpuMs?: Float32Array; nGpu?: number };
  if (!s.gpuMs || typeof s.nGpu !== 'number') return [];
  const out: number[] = [];
  const from = Math.max(cursor.n, s.nGpu - s.gpuMs.length);
  for (let i = from; i < s.nGpu; i++) out.push(s.gpuMs[i & (s.gpuMs.length - 1)]);
  cursor.n = s.nGpu;
  return out;
}

export function startPerfPanel(host: HTMLElement, board: Corkboard): () => void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.className = 'perf';
  root.setAttribute('aria-label', 'Performance');
  host.appendChild(root);

  const make = (name: string, o: Pick<Series, 'unit' | 'digits' | 'floor' | 'ref' | 'none'>): Series => {
    const tile = document.createElement('div');
    tile.className = 'perf-tile';
    const label = document.createElement('span');
    label.className = 'perf-name';
    label.textContent = name;
    const value = document.createElement('span');
    value.className = 'perf-value';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${name} over the last 30 seconds`);
    tile.append(label, value, canvas);
    root.appendChild(tile);
    const s: Series = { ...o, values: [], times: [], value, canvas, hover: null };
    // Hover: the value at that moment, and how long ago (drawn with the next frame).
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      s.hover = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    });
    canvas.addEventListener('pointerleave', () => {
      s.hover = null;
    });
    return s;
  };

  const fps = make('FPS', { unit: '', digits: 0, floor: 60, ref: 60, none: 'n/a' });
  const cpu = make('CPU · main thread', { unit: '%', digits: 0, floor: 100, none: 'n/a' });
  const gpu = make('GPU · board render', { unit: 'ms', digits: 2, floor: 2, none: 'idle' });
  const vram = make('VRAM · board textures', { unit: 'MB', digits: 0, floor: 64, none: 'n/a' });
  const all = [fps, cpu, gpu, vram];

  // Frame rate: the frames of the last second, counted again at every step (steady, yet current).
  const stamps: number[] = [];
  let raf = 0;
  const tick = (t: number): void => {
    stamps.push(t);
    // Scroll with every frame, while the panel is open.
    if (root.offsetParent !== null) for (const s of all) draw(s, t);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  // Main-thread idle time: the idle periods the browser hands out, summed. Busy = the rest of the step.
  let idle = 0;
  let ric = 0;
  const hasIdle = typeof requestIdleCallback === 'function';
  const onIdle = (d: IdleDeadline): void => {
    idle += d.timeRemaining();
    ric = requestIdleCallback(onIdle);
  };
  if (hasIdle) ric = requestIdleCallback(onIdle);

  // The theme's tokens, read with each sample rather than in every frame's draw.
  const theme = new Map<string, string>();
  const readTheme = (): void => {
    const css = getComputedStyle(document.body);
    for (const t of ['--border-strong', '--muted-fg', '--panel-solid']) theme.set(t, css.getPropertyValue(t).trim());
    theme.set('light', document.body.classList.contains('light') ? '1' : '0');
  };
  readTheme();

  const cursor = { n: 0 };
  let gpuOff = false;
  let vramMb: number | null = null;
  let statsAt = 0;
  let last = performance.now();
  const timer = window.setInterval(() => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    while (stamps.length > 0 && stamps[0] < now - 1000) stamps.shift();
    push(fps, stamps.length);
    push(cpu, hasIdle ? Math.min(100, Math.max(0, 100 * (1 - idle / dt))) : null);
    idle = 0;
    // `stats()` sorts its history: once a second is enough for what only it knows.
    if (now - statsAt >= 1000) {
      statsAt = now;
      const st = board.stats() as { gpuMs?: unknown; textureBytes?: number };
      gpuOff = typeof st.gpuMs !== 'object';
      vramMb = typeof st.textureBytes === 'number' ? st.textureBytes / 1048576 : null;
    }
    const g = gpuSince(board, cursor);
    gpu.none = gpuOff ? 'n/a' : 'idle';
    push(gpu, gpuOff || g.length === 0 ? null : g.reduce((a, b) => a + b, 0) / g.length);
    push(vram, vramMb);
    readTheme();
  }, STEP_MS);

  function push(s: Series, v: number | null): void {
    s.values.push(v);
    s.times.push(performance.now());
    if (s.values.length > SAMPLES) {
      s.values.shift();
      s.times.shift();
    }
  }

  function draw(s: Series, now: number): void {
    const { canvas, value } = s;
    const n = s.values.length;
    // The newest sample sits at the right edge one step after it was taken, so the line enters smoothly.
    const right = now - STEP_MS;
    const left = right - WINDOW_MS;
    // Hovered: the sample nearest the pointer's time; otherwise the latest.
    let i = n - 1;
    if (s.hover !== null && n > 0) {
      const t = left + s.hover * WINDOW_MS;
      let best = Infinity;
      for (let k = 0; k < n; k++) {
        const d = Math.abs(s.times[k] - t);
        if (d < best) {
          best = d;
          i = k;
        }
      }
    }
    const v = i >= 0 && i < n ? s.values[i] : null;
    const ago = s.hover !== null && i >= 0 ? ` · ${((now - s.times[i]) / 1000).toFixed(1)}s ago` : '';
    const text = (v === null ? s.none : `${v.toFixed(s.digits)}${s.unit ? ` ${s.unit}` : ''}`) + ago;
    if (value.textContent !== text) value.textContent = text;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (w === 0 || h === 0) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    const tok = (name: string, fallback: string): string => theme.get(name) || fallback;
    const light = theme.get('light') === '1';
    // Series slot 1 of the palette, in this theme's step.
    const ink = light ? '#2a78d6' : '#3987e5';
    g.clearRect(0, 0, w, h);
    let top = s.floor;
    for (const x of s.values) if (x !== null && x > top) top = x;
    top *= 1.08;
    const pad = 2 * dpr;
    const x = (k: number): number => ((s.times[k] - left) / WINDOW_MS) * (w - 2 * pad) + pad;
    const y = (val: number): number => h - pad - (val / top) * (h - 2 * pad);

    // Baseline, and the reference line (60 fps).
    g.lineWidth = dpr;
    g.strokeStyle = tok('--border-strong', 'rgba(255,255,255,.14)');
    g.beginPath();
    g.moveTo(0, h - dpr / 2);
    g.lineTo(w, h - dpr / 2);
    g.stroke();
    if (s.ref !== undefined) {
      g.setLineDash([3 * dpr, 3 * dpr]);
      g.beginPath();
      g.moveTo(0, Math.round(y(s.ref)) + 0.5);
      g.lineTo(w, Math.round(y(s.ref)) + 0.5);
      g.stroke();
      g.setLineDash([]);
    }

    // Runs of consecutive values: an area under a 2 px line, a gap where there is none.
    const runs: number[][] = [];
    let run: number[] = [];
    s.values.forEach((val, k) => {
      if (val === null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push(k);
    });
    if (run.length) runs.push(run);
    for (const r of runs) {
      const vals = s.values as number[];
      g.beginPath();
      g.moveTo(x(r[0]), h);
      for (const k of r) g.lineTo(x(k), y(vals[k]));
      g.lineTo(x(r[r.length - 1]), h);
      g.closePath();
      g.globalAlpha = 0.16;
      g.fillStyle = ink;
      g.fill();
      g.globalAlpha = 1;
      g.beginPath();
      r.forEach((k, j) => (j === 0 ? g.moveTo(x(k), y(vals[k])) : g.lineTo(x(k), y(vals[k]))));
      if (r.length === 1) g.lineTo(x(r[0]) + dpr, y(vals[r[0]]));
      g.strokeStyle = ink;
      g.lineWidth = 2 * dpr;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.stroke();
    }

    // Hover crosshair and marker.
    if (s.hover !== null && n > 0 && i >= 0) {
      g.strokeStyle = tok('--muted-fg', '#a1a1aa');
      g.lineWidth = dpr;
      g.beginPath();
      g.moveTo(x(i), 0);
      g.lineTo(x(i), h);
      g.stroke();
      if (v !== null) {
        g.fillStyle = ink;
        g.strokeStyle = tok('--panel-solid', '#111113');
        g.lineWidth = 2 * dpr;
        g.beginPath();
        g.arc(x(i), y(v), 4 * dpr, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
  }

  return () => {
    clearInterval(timer);
    cancelAnimationFrame(raf);
    if (hasIdle) cancelIdleCallback(ric);
    root.remove();
    style.remove();
  };
}
