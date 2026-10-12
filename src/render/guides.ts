// Smart guides, drawn in SCREEN space by the overlay (render/overlay.ts) while a box is moved or resized: alignment lines with a "×" where they meet each aligned box, spacing and size measures
// with end caps and a small label pill. The model comes from interact/snapping.ts in world units.
//
// The look is a hairline system: every line is exactly one DEVICE pixel wide and sits on the device
// pixel grid (filled rects, not strokes), so it is equally crisp at any zoom and pixel ratio. One hue of
// its own (theme.guide), apart from the selection's accent. Guides fade in and out over GUIDE_FADE_MS,
// keyed by what they show (an alignment line by its axis, kind and position; a measure by its
// segment), so a guide that stays while the pointer moves within the snap threshold never blinks, and
// one that goes leaves gently. The layer only redraws when its guides, the camera or a fade changed.
//
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Camera } from '../math';
import type { Guide, LineGuide } from '../interact/snapping';
import { guideColor, type Theme } from './theme';

const UI_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export const GUIDE_FADE_MS = 80;
// Screen px (CSS): half the size of a "×" mark and half the length of a measure's end cap.
const MARK_ARM = 3;
const CAP_HALF = 3.5;
// The label pill: height, horizontal padding, corner radius, and its distance from a segment too short
// to hold it (the pill then sits beside the segment).
const PILL_H = 16;
const PILL_PAD = 5;
const PILL_RADIUS = 4;
const PILL_OFFSET = 4;
const LABEL_SIZE = 11;
// A width / height match shows this instead of a number.
const MATCH_LABEL = '=';
// The corners of an arm of a mark, as signs of (u, v) (see GuideLayer.line).
const MARK_CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

interface Entry {
  key: string;
  guide: Guide;
  alpha: number;
  // 1 while the guide is set, 0 once it is gone (it fades out, then is dropped).
  target: 0 | 1;
}

// One pooled label. `label` and `w` cache what the Text shows and its pill width (screen px).
interface PillLabel {
  text: Text;
  label: string;
  w: number;
}

const isMeasure = (g: Guide): boolean => g.kind === 'gap' || g.kind === 'width';

// World units are rounded to 1/100 in the keys: the snapper's own epsilon.
const k = (v: number): number => Math.round(v * 100);

// What a guide IS, independently of how far it runs: an alignment line by its axis, kind and position
// (it grows and shrinks as the box slides along it); a measure by its segment and kind (its position
// across the segment moves as the box slides across it).
export function guideKey(g: Guide): string {
  if (isMeasure(g)) return `${g.kind}|${g.axis}|${k(g.from)}|${k(g.to)}`;
  return `${g.kind}|${g.axis}|${k(g.at)}`;
}

function sameGeometry(a: Guide, b: Guide): boolean {
  if (a.at !== b.at || a.from !== b.from || a.to !== b.to) return false;
  if (isMeasure(a)) return (a as { label: number }).label === (b as { label: number }).label;
  const ma = (a as LineGuide).marks;
  const mb = (b as LineGuide).marks;
  if (ma === mb) return true;
  if (!ma || !mb || ma.length !== mb.length) return false;
  for (let i = 0; i < ma.length; i++) if (ma[i] !== mb[i]) return false;
  return true;
}

export class GuideLayer {
  readonly container = new Container();
  // Lines, caps and marks; the pills go on top of them, then the labels.
  private readonly lines = new Graphics();
  private readonly pillBg = new Graphics();
  private readonly pillStyle: TextStyle;
  private readonly pills: PillLabel[] = [];
  private pillsUsed = 0;
  private entries: Entry[] = [];
  private color: number;
  private dirty = false;
  private lastNow = NaN;
  private readonly lastCam = { tx: NaN, ty: NaN, scale: NaN };
  // Pill rects placed this frame (screen px: x, y, w, h), to keep two labels from overlapping.
  private readonly placed: number[] = [];

  constructor(
    theme: Theme,
    private readonly dpr = 1,
  ) {
    this.container.eventMode = 'none';
    this.lines.eventMode = 'none';
    this.pillBg.eventMode = 'none';
    this.container.addChild(this.lines, this.pillBg);
    this.color = guideColor(theme);
    this.pillStyle = new TextStyle({
      fontFamily: UI_FONT,
      fontSize: LABEL_SIZE,
      fontWeight: '600',
      fill: theme.onGuide ?? 0xffffff,
    });
  }

  setTheme(theme: Theme): void {
    this.color = guideColor(theme);
    this.pillStyle.fill = theme.onGuide ?? 0xffffff;
    this.dirty = true;
  }

  // The guides to show now. Returns true when that changes anything on screen (the caller asks for a
  // frame); the same guides again (a pointer move that stays snapped) change nothing.
  set(guides: readonly Guide[]): boolean {
    let changed = false;
    const seen = new Set<string>();
    const next: Entry[] = [];
    const prev = new Map<string, Entry>();
    for (const e of this.entries) prev.set(e.key, e);
    for (const g of guides) {
      const key = guideKey(g);
      // Two guides that show the same thing (the snapper merges most): the first one wins.
      if (seen.has(key)) continue;
      seen.add(key);
      const e = prev.get(key);
      if (e) {
        if (e.target !== 1 || !sameGeometry(e.guide, g)) changed = true;
        e.guide = g;
        e.target = 1;
        next.push(e);
        prev.delete(key);
      } else {
        next.push({ key, guide: g, alpha: 0, target: 1 });
        changed = true;
      }
    }
    // The ones no longer set fade out from where they were.
    for (const e of prev.values()) {
      if (e.target !== 0) changed = true;
      e.target = 0;
      next.push(e);
    }
    this.entries = next;
    if (changed) this.dirty = true;
    return changed;
  }

  // The guides currently set (fading-out ones excluded).
  get current(): Guide[] {
    const out: Guide[] = [];
    for (const e of this.entries) if (e.target === 1) out.push(e.guide);
    return out;
  }

  // How many guides are set (fading-out ones excluded).
  get count(): number {
    let n = 0;
    for (const e of this.entries) if (e.target === 1) n++;
    return n;
  }

  // Anything on screen (set or still fading out).
  get active(): boolean {
    return this.entries.length > 0;
  }

  // A fade is running: the caller keeps the frames coming.
  get animating(): boolean {
    for (const e of this.entries) if (e.alpha !== e.target) return true;
    return false;
  }

  // Advances the fades to `now` and redraws when anything changed. Returns true when it redrew.
  draw(cam: Camera, now: number): boolean {
    const dt = Number.isFinite(this.lastNow) ? Math.min(50, Math.max(0, now - this.lastNow)) : 16;
    this.lastNow = now;
    let fading = false;
    const step = dt / GUIDE_FADE_MS;
    let kept = 0;
    for (const e of this.entries) {
      if (e.alpha !== e.target) {
        e.alpha = e.target === 1 ? Math.min(1, e.alpha + step) : Math.max(0, e.alpha - step);
        fading = true;
      }
      if (e.target === 0 && e.alpha === 0) continue;
      this.entries[kept++] = e;
    }
    const dropped = kept !== this.entries.length;
    this.entries.length = kept;
    const camChanged =
      cam.tx !== this.lastCam.tx || cam.ty !== this.lastCam.ty || cam.scale !== this.lastCam.scale;
    if (!this.dirty && !fading && !dropped && !(camChanged && kept > 0)) return false;
    this.lastCam.tx = cam.tx;
    this.lastCam.ty = cam.ty;
    this.lastCam.scale = cam.scale;
    this.dirty = false;
    this.redraw(cam);
    return true;
  }

  // ── Drawing ──────────────────────────────────────────────────────────────────────────────────────

  private redraw(cam: Camera): void {
    const g = this.lines;
    const bg = this.pillBg;
    g.clear();
    bg.clear();
    this.placed.length = 0;
    let used = 0;
    // The lines with their marks first, the measures last.
    for (let pass = 0; pass < 2; pass++) {
      for (const e of this.entries) {
        const gd = e.guide;
        const p = isMeasure(gd) ? 1 : 0;
        if (p !== pass || e.alpha <= 0) continue;
        if (p === 1) used = this.measure(gd, cam, e.alpha, used);
        else this.line(gd as LineGuide, cam, e.alpha);
      }
    }
    for (let i = used; i < this.pillsUsed; i++) this.pills[i].text.visible = false;
    this.pillsUsed = used;
  }

  // The device pixel a screen coordinate falls in, as its left / top edge in screen px.
  private cell(v: number): number {
    return Math.floor(v * this.dpr + 1e-6) / this.dpr;
  }

  // A screen coordinate rounded to the device pixel grid.
  private snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  // A one-device-pixel hairline along `axis` ('x': vertical at screen x = `at`, from `a` to `b` in y).
  private hairline(axis: 'x' | 'y', at: number, a: number, b: number): void {
    const g = this.lines;
    const hp = 1 / this.dpr;
    const c = this.cell(at);
    const lo = this.snap(Math.min(a, b));
    const hi = this.snap(Math.max(a, b));
    if (!(hi > lo)) {
      if (axis === 'x') g.rect(c, lo, hp, hp);
      else g.rect(lo, c, hp, hp);
      return;
    }
    if (axis === 'x') g.rect(c, lo, hp, hi - lo + hp);
    else g.rect(lo, c, hi - lo + hp, hp);
  }

  // An alignment line, with a "×" at each of its marks.
  private line(gd: LineGuide, cam: Camera, alpha: number): void {
    const g = this.lines;
    const vertical = gd.axis === 'x';
    const at = vertical ? cam.tx + gd.at * cam.scale : cam.ty + gd.at * cam.scale;
    const o = vertical ? cam.ty : cam.tx;
    const a = o + gd.from * cam.scale;
    const b = o + gd.to * cam.scale;
    this.hairline(gd.axis, at, a, b);
    g.fill({ color: this.color, alpha });
    const marks = gd.marks;
    if (!marks || marks.length === 0) return;
    // The × is not stroked: a thin diagonal stroke breaks up on a canvas without antialiasing. Each
    // arm is a thin parallelogram along a diagonal whose edges fall between pixel centres, so the GPU
    // fills a clean staircase of whole device pixels, `t` of them thick (two from a pixel ratio of 2,
    // about one CSS pixel) and symmetric about the mark: centred on the hairline's pixel for t = 1, on
    // the corner after it for t = 2. Two polygons per mark.
    const hp = 1 / this.dpr;
    const t = this.dpr >= 2 ? 2 : 1;
    const n = Math.max(2, Math.round(MARK_ARM * this.dpr) - (t - 1));
    // In device pixels: the half-width across the diagonal and the half-length along it (u = x - y,
    // v = x + y); pixel centres sit on whole u, and the bounds fall halfway between them.
    const hu = t === 1 ? 0.5 : 1.5;
    const hv = t === 1 ? 2 * n + 0.5 : 2 * n + 1.5;
    const off = t === 1 ? hp / 2 : hp;
    const across = this.cell(at) + off;
    for (const m of marks) {
      const along = this.cell(o + m * cam.scale) + off;
      const ox = vertical ? across : along;
      const oy = vertical ? along : across;
      for (const dir of [1, -1]) {
        // A fresh array: the path keeps a reference to it.
        const pts = new Array<number>(8);
        let i = 0;
        for (const [u, v] of MARK_CORNERS) {
          pts[i++] = ox + ((u * hu + v * hv) / 2) * hp;
          pts[i++] = oy + ((dir * (v * hv - u * hu)) / 2) * hp;
        }
        g.poly(pts, true);
      }
    }
    g.fill({ color: this.color, alpha });
  }

  // A spacing or size measure: the segment with an end cap at each end and its label in a pill.
  private measure(gd: Guide, cam: Camera, alpha: number, used: number): number {
    const g = this.lines;
    // Measures run ALONG their axis: 'x' is a horizontal segment at y = `at`.
    const horizontal = gd.axis === 'x';
    const at = horizontal ? cam.ty + gd.at * cam.scale : cam.tx + gd.at * cam.scale;
    const o = horizontal ? cam.tx : cam.ty;
    const a = o + gd.from * cam.scale;
    const b = o + gd.to * cam.scale;
    const lineAxis = horizontal ? 'y' : 'x';
    const capAxis = horizontal ? 'x' : 'y';
    this.hairline(lineAxis, at, a, b);
    // The caps sit on the segment's two end pixels.
    const hp = 1 / this.dpr;
    const ea = this.snap(Math.min(a, b));
    const eb = this.snap(Math.max(a, b));
    const mid = this.cell(at) + hp / 2;
    this.hairline(capAxis, ea, mid - CAP_HALF, mid + CAP_HALF);
    this.hairline(capAxis, eb, mid - CAP_HALF, mid + CAP_HALF);
    g.fill({ color: this.color, alpha });

    const label = gd.kind === 'width' ? MATCH_LABEL : String((gd as { label: number }).label);
    const pill = this.pill(used, label);
    const w = pill.w;
    const h = PILL_H;
    const len = eb - ea;
    // Centred on the segment when it is long enough to hold the pill with its caps showing, beside it
    // (below a horizontal segment, right of a vertical one) otherwise.
    let cx: number;
    let cy: number;
    if (horizontal) {
      cx = (ea + eb) / 2;
      cy = len >= w + 4 * CAP_HALF ? mid : mid + CAP_HALF + PILL_OFFSET + h / 2;
    } else {
      cy = (ea + eb) / 2;
      cx = len >= h + 4 * CAP_HALF ? mid : mid + CAP_HALF + PILL_OFFSET + w / 2;
    }
    const x = this.snap(cx - w / 2);
    const y = this.snap(cy - h / 2);
    if (this.overlapsPlaced(x, y, w, h)) {
      return used;
    }
    this.placed.push(x, y, w, h);
    this.pillBg.roundRect(x, y, w, h, PILL_RADIUS).fill({ color: this.color, alpha });
    const t = pill.text;
    t.position.set(this.snap(x + (w - t.width) / 2), this.snap(y + (h - t.height) / 2));
    t.alpha = alpha;
    t.visible = true;
    return used + 1;
  }

  private overlapsPlaced(x: number, y: number, w: number, h: number): boolean {
    const p = this.placed;
    for (let i = 0; i < p.length; i += 4) {
      if (x < p[i] + p[i + 2] && x + w > p[i] && y < p[i + 1] + p[i + 3] && y + h > p[i + 1]) {
        return true;
      }
    }
    return false;
  }

  // The pooled label at `i` showing `label`, grown on demand and never shrunk.
  private pill(i: number, label: string): PillLabel {
    let pill = this.pills[i];
    if (!pill) {
      const text = new Text({ text: '', style: this.pillStyle });
      text.eventMode = 'none';
      text.visible = false;
      this.container.addChild(text);
      pill = { text, label: '', w: 0 };
      this.pills.push(pill);
    }
    if (pill.label !== label) {
      pill.text.text = label;
      pill.label = label;
      // At least as wide as tall: a one-digit label is a rounded square, not a sliver.
      pill.w = Math.max(PILL_H, Math.ceil(pill.text.width + 2 * PILL_PAD));
    }
    return pill;
  }
}
