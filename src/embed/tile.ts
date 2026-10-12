// The generated poster of an embed with no picture: a themed tile with the host, the title and a glyph,
// drawn on a canvas. `tileSpec` (pure) decides what it says; `drawTile` paints it.
import type { Theme } from '../render/theme';
import { cssHex } from '../render/theme';
import type { ResolvedEmbed } from './resolve';

export type TileGlyph = 'play' | 'music' | 'code' | 'design' | 'globe' | 'link-off';

export interface TileSpec {
  glyph: TileGlyph;
  // Top line (provider or host), small caps.
  label: string;
  // The main text; may be empty.
  title: string;
  // 0..359, from the host: the same site always gets the same colour.
  hue: number;
}

export function hostHue(host: string): number {
  let h = 2166136261;
  for (let i = 0; i < host.length; i++) {
    h ^= host.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

const GLYPH: Record<ResolvedEmbed['provider'], TileGlyph> = {
  youtube: 'play',
  vimeo: 'play',
  spotify: 'music',
  codepen: 'code',
  figma: 'design',
  generic: 'globe',
};

export function tileSpec(r: ResolvedEmbed): TileSpec {
  let glyph: TileGlyph = r.kind === 'html' ? 'code' : GLYPH[r.provider];
  if (r.kind === 'url' && r.iframeSrc === null) glyph = 'link-off';
  else if (r.kind === 'url' && !r.frameable && r.provider === 'generic') glyph = 'link-off';
  const title =
    r.title ?? (r.kind === 'html' ? 'HTML snippet' : r.provider === 'generic' ? pathOf(r.url) : '');
  return { glyph, label: r.label, title, hue: hostHue(r.host) };
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '');
    return p === '' ? '' : p.replace(/[_-]+/g, ' ').split('/').pop() ?? '';
  } catch {
    return '';
  }
}

export const TILE_WIDTH = 640;
const TILE_MAX_HEIGHT = 1024;

export function tileSize(aspect: number): { w: number; h: number } {
  const h = Math.min(TILE_MAX_HEIGHT, Math.max(120, Math.round(TILE_WIDTH * aspect)));
  return { w: TILE_WIDTH, h };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function wrap(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line === '' ? w : `${line} ${w}`;
    if (ctx.measureText(next).width <= maxW || line === '') line = next;
    else {
      lines.push(line);
      line = w;
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line !== '') lines.push(line);
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

function drawGlyph(ctx: Ctx, g: TileGlyph, cx: number, cy: number, s: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.07;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (g === 'play') {
    ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.14, cy - s * 0.24);
    ctx.lineTo(cx + s * 0.26, cy);
    ctx.lineTo(cx - s * 0.14, cy + s * 0.24);
    ctx.closePath();
    ctx.fill();
  } else if (g === 'globe' || g === 'link-off') {
    ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, s * 0.22, s * 0.5, 0, 0, Math.PI * 2);
    ctx.moveTo(cx - s * 0.5, cy);
    ctx.lineTo(cx + s * 0.5, cy);
    ctx.stroke();
    if (g === 'link-off') {
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.42, cy + s * 0.42);
      ctx.lineTo(cx + s * 0.42, cy - s * 0.42);
      ctx.stroke();
    }
  } else if (g === 'code') {
    ctx.moveTo(cx - s * 0.18, cy - s * 0.3);
    ctx.lineTo(cx - s * 0.48, cy);
    ctx.lineTo(cx - s * 0.18, cy + s * 0.3);
    ctx.moveTo(cx + s * 0.18, cy - s * 0.3);
    ctx.lineTo(cx + s * 0.48, cy);
    ctx.lineTo(cx + s * 0.18, cy + s * 0.3);
    ctx.moveTo(cx + s * 0.07, cy - s * 0.38);
    ctx.lineTo(cx - s * 0.07, cy + s * 0.38);
    ctx.stroke();
  } else if (g === 'music') {
    ctx.moveTo(cx + s * 0.2, cy - s * 0.42);
    ctx.lineTo(cx + s * 0.2, cy + s * 0.26);
    ctx.moveTo(cx + s * 0.2, cy - s * 0.42);
    ctx.lineTo(cx - s * 0.3, cy - s * 0.3);
    ctx.lineTo(cx - s * 0.3, cy + s * 0.34);
    ctx.stroke();
    for (const x of [cx - s * 0.4, cx + s * 0.1]) {
      ctx.beginPath();
      ctx.ellipse(x + s * 0.1, cy + s * 0.34, s * 0.14, s * 0.1, -0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // design: a frame with a plus
    ctx.rect(cx - s * 0.42, cy - s * 0.42, s * 0.84, s * 0.84);
    ctx.moveTo(cx, cy - s * 0.2);
    ctx.lineTo(cx, cy + s * 0.2);
    ctx.moveTo(cx - s * 0.2, cy);
    ctx.lineTo(cx + s * 0.2, cy);
    ctx.stroke();
  }
  ctx.restore();
}

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Paints the tile on `ctx` (size w x h). The theme decides light or dark; the hue is the site's.
export function paintTile(ctx: Ctx, w: number, h: number, spec: TileSpec, theme: Theme): void {
  const dark = theme.dark;
  const hsl = (s: number, l: number): string => `hsl(${spec.hue} ${s}% ${l}%)`;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, dark ? hsl(34, 20) : hsl(40, 90));
  g.addColorStop(1, dark ? hsl(30, 12) : hsl(34, 82));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const fg = dark ? hsl(30, 88) : hsl(50, 24);
  const dim = dark ? hsl(20, 70) : hsl(30, 38);

  // One centred group: glyph, label, title. Sizes follow the tile's width, so text reads at card size.
  const pad = Math.round(w * 0.06);
  const glyph = Math.round(Math.min(w * 0.2, h * 0.34));
  const labelPx = Math.round(w * 0.04);
  const titlePx = Math.round(w * 0.055);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.font = `600 ${titlePx}px ${FONT}`;
  const lines = spec.title === '' ? [] : wrap(ctx, spec.title, w - pad * 2, h < 260 ? 1 : 2);
  const gap = Math.round(glyph * 0.28);
  const groupH =
    glyph + gap + labelPx + (lines.length > 0 ? Math.round(titlePx * 0.5) + lines.length * titlePx * 1.2 : 0);
  let y = Math.max(pad * 0.5, (h - groupH) / 2);
  drawGlyph(ctx, spec.glyph, w / 2, y + glyph / 2, glyph, cssHex(theme.accent));
  y += glyph + gap + labelPx;
  ctx.fillStyle = dim;
  ctx.font = `700 ${labelPx}px ${FONT}`;
  ctx.fillText(spec.label.toUpperCase(), w / 2, y, w - pad * 2);
  if (lines.length > 0) {
    ctx.fillStyle = fg;
    ctx.font = `600 ${titlePx}px ${FONT}`;
    y += Math.round(titlePx * 0.5);
    for (const l of lines) {
      y += titlePx * 1.2;
      ctx.fillText(l, w / 2, y - titlePx * 0.2, w - pad * 2);
    }
  }
}

// A PNG blob of the tile, or null where there is no canvas (SSR, jsdom).
export async function drawTile(spec: TileSpec, aspect: number, theme: Theme): Promise<Blob | null> {
  const { w, h } = tileSize(aspect);
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    paintTile(ctx, w, h, spec, theme);
    return c.convertToBlob({ type: 'image/png' });
  }
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  paintTile(ctx, w, h, spec, theme);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
}
