// Checks on the options the host passes to `Corkboard.create`, the `set*` / `setOptions` methods and the camera and
// layout calls. A bad value is refused up front with a `CorkboardError('invalid')` that names the option, instead
// of a raw TypeError later or a NaN that ends up in the camera, the store or a layer's budget. Numbers must be
// finite and in range; `Infinity` is accepted only where the option documents "no cap".
import type { ArrangeOptions, CameraMoveOptions, GridOptions, MasonryOptions } from './api';
import type { CorkboardOptions, TextureOptions } from './Corkboard';
import type { EmbedOptions } from './embed/layer';
import type { InteractionOptions } from './interact/controller';
import type { SnapSettings } from './interact/snap';
import { DARK_THEME, LIGHT_THEME, type Theme } from './render/theme';
import type { VideoOptions } from './video/layer';
import { bad, boolean, finite, integer, isObject, limit, nonNegative, oneOf, positive, record, show } from './check';

/** The keys of `o` that are set (an `undefined` value means "leave it", as in the setters). */
const given = <T extends object>(o: T): (keyof T & string)[] =>
  (Object.keys(o) as (keyof T & string)[]).filter((k) => o[k] !== undefined);

// 0 < min <= max, both finite (also checks the `camera` option at create).
export function assertRange(where: string, min: unknown, max: unknown): void {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!ok(min) || !ok(max) || min > max) {
    bad(where, `needs finite numbers with 0 < min <= max (got min ${show(min)}, max ${show(max)})`);
  }
}

// ── Theme ────────────────────────────────────────────────────────────────────
const THEMES = { dark: DARK_THEME, light: LIGHT_THEME } as const;

const color = (where: string, field: string, v: unknown): void => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffff) {
    bad(where, `${field} must be a colour number 0x000000..0xffffff (got ${show(v)})`);
  }
};

const unit = (where: string, field: string, v: unknown): void => {
  if (typeof v !== 'number' || !(v >= 0 && v <= 1)) bad(where, `${field} must be a number from 0 to 1 (got ${show(v)})`);
};

/** `'dark'`, `'light'` or a whole {@link Theme}, as the theme to use. `undefined` is the dark one. */
export function resolveTheme(where: string, t: unknown): Theme {
  if (t === undefined) return DARK_THEME;
  if (t === 'dark' || t === 'light') return THEMES[t];
  if (!isObject(t) || Array.isArray(t)) {
    return bad(where, `theme must be 'dark', 'light' or a Theme object (got ${show(t)})`);
  }
  boolean(where, 'theme.dark', t.dark);
  for (const k of ['canvas', 'dot', 'border', 'accent', 'well']) color(where, `theme.${k}`, t[k]);
  unit(where, 'theme.borderAlpha', t.borderAlpha);
  if (t.dotAlpha !== undefined) unit(where, 'theme.dotAlpha', t.dotAlpha);
  if (t.guide !== undefined) color(where, 'theme.guide', t.guide);
  if (t.onGuide !== undefined) color(where, 'theme.onGuide', t.onGuide);
  return t as unknown as Theme;
}

// ── Snapping ─────────────────────────────────────────────────────────────────
/** `setSnapping` / the `snapping` option: a boolean, or `{ guides?, grid? }`. */
export function checkSnapping(where: string, s: unknown): Partial<SnapSettings> | boolean {
  if (typeof s === 'boolean') return s;
  const o = record(where, 'snapping', s);
  for (const k of given(o)) {
    if (k === 'guides' || k === 'grid') boolean(where, `snapping.${k}`, o[k]);
  }
  return o as Partial<SnapSettings>;
}

// ── Video ────────────────────────────────────────────────────────────────────
/** `video` at create, `video.setOptions`. */
export function checkVideoOptions(where: string, o: unknown): VideoOptions {
  const v = record(where, 'options', o) as VideoOptions & Record<string, unknown>;
  if (v.mode !== undefined) oneOf(where, 'mode', v.mode, ['always', 'hover', 'off']);
  if (v.loop !== undefined) boolean(where, 'loop', v.loop);
  if (v.muted !== undefined) boolean(where, 'muted', v.muted);
  if (v.minPlayPx !== undefined) nonNegative(where, 'minPlayPx', v.minPlayPx);
  if (v.maxPlaying !== undefined) limit(where, 'maxPlaying', v.maxPlaying);
  if (v.maxPlayingTouch !== undefined) limit(where, 'maxPlayingTouch', v.maxPlayingTouch);
  return v;
}

// ── Embeds ───────────────────────────────────────────────────────────────────
const LIMITS = [
  'maxLive',
  'maxLiveTouch',
  'maxMounted',
  'maxMountedTouch',
  'maxOffscreen',
  'maxOffscreenTouch',
  'maxLoading',
  'maxAnimating',
] as const;

/** `embeds` at create, `embeds.setOptions`. (`isolatedHosts` is checked, and normalised, by the layer.) */
export function checkEmbedOptions(where: string, o: unknown): EmbedOptions {
  const e = record(where, 'options', o) as EmbedOptions & Record<string, unknown>;
  for (const k of LIMITS) if (e[k] !== undefined) limit(where, k, e[k]);
  if (e.cullMargin !== undefined) nonNegative(where, 'cullMargin', e.cullMargin);
  if (e.minLiveScale !== undefined) nonNegative(where, 'minLiveScale', e.minLiveScale);
  if (e.resolveTimeoutMs !== undefined) nonNegative(where, 'resolveTimeoutMs', e.resolveTimeoutMs);
  if (e.freezePx !== undefined) nonNegative(where, 'freezePx', e.freezePx);
  if (e.previewWorkers !== undefined) integer(where, 'previewWorkers', e.previewWorkers, 0);
  if (e.minLivePx !== undefined) {
    const m = e.minLivePx;
    if (isObject(m)) {
      nonNegative(where, 'minLivePx.w', m.w);
      nonNegative(where, 'minLivePx.h', m.h);
    } else nonNegative(where, 'minLivePx', m);
  }
  if (e.resolve !== undefined && typeof e.resolve !== 'function') {
    bad(where, `resolve must be a function (got ${show(e.resolve)})`);
  }
  if (e.resolution !== undefined && e.resolution !== '720p' && e.resolution !== '1080p' && e.resolution !== 'native') {
    if (typeof e.resolution !== 'number') {
      bad(where, `resolution must be '720p', '1080p', 'native' or a number > 0 (got ${show(e.resolution)})`);
    }
    positive(where, 'resolution', e.resolution);
  }
  if (e.arbitrarySameOrigin !== undefined) boolean(where, 'arbitrarySameOrigin', e.arbitrarySameOrigin);
  if (e.autoplay !== undefined) boolean(where, 'autoplay', e.autoplay);
  if (e.adaptive !== undefined) boolean(where, 'adaptive', e.adaptive);
  if (e.snippetNetwork !== undefined) oneOf(where, 'snippetNetwork', e.snippetNetwork, ['images', 'none']);
  if (e.isolatedHosts !== undefined && !Array.isArray(e.isolatedHosts)) {
    bad(where, `isolatedHosts must be an array of host strings (got ${show(e.isolatedHosts)})`);
  }
  if (e.previewCache !== undefined) {
    const c = e.previewCache;
    const ok =
      c === 'memory' ||
      c === 'persistent' ||
      (isObject(c) && c.persistent === true && (c.name === undefined || typeof c.name === 'string'));
    if (!ok) bad(where, `previewCache must be 'memory', 'persistent' or { persistent: true, name? } (got ${show(c)})`);
  }
  return e;
}

// ── Interaction ──────────────────────────────────────────────────────────────
/** `interaction` as an object at create, `interaction.setOptions`. */
export function checkInteractionOptions(where: string, o: unknown): InteractionOptions {
  const i = record(where, 'options', o) as InteractionOptions & Record<string, unknown>;
  for (const k of ['select', 'keyboard', 'commit', 'marquee', 'keepSelectionOnPan', 'selectionOutline'] as const) {
    if (i[k] !== undefined) boolean(where, k, i[k]);
  }
  if (i.emptyDrag !== undefined) oneOf(where, 'emptyDrag', i.emptyDrag, ['pan', 'marquee']);
  return i;
}

// ── Textures ─────────────────────────────────────────────────────────────────
/** `textures` at create. */
export function checkTextureOptions(where: string, o: unknown): TextureOptions {
  const t = record(where, 'textures', o) as TextureOptions & Record<string, unknown>;
  if (t.budgetBytes !== undefined) positive(where, 'textures.budgetBytes', t.budgetBytes);
  if (t.workers !== undefined) integer(where, 'textures.workers', t.workers, 1);
  if (t.uploadBudgetMs !== undefined) positive(where, 'textures.uploadBudgetMs', t.uploadBudgetMs);
  if (t.overscan !== undefined) nonNegative(where, 'textures.overscan', t.overscan);
  if (t.softCanvas !== undefined) boolean(where, 'textures.softCanvas', t.softCanvas);
  if (t.workerUrl !== undefined && typeof t.workerUrl !== 'string' && !(t.workerUrl instanceof URL)) {
    bad(where, `textures.workerUrl must be a string or a URL (got ${show(t.workerUrl)})`);
  }
  return t;
}

// ── Create ───────────────────────────────────────────────────────────────────
/** Every option of `Corkboard.create`, before anything is made. Returns the options as an object. */
export function checkCreateOptions(host: unknown, options: unknown): CorkboardOptions {
  const where = 'Corkboard.create';
  if (!isObject(host) || (host as { nodeType?: unknown }).nodeType !== 1) {
    bad(where, `host must be an HTMLElement (got ${show(host)})`);
  }
  const o = (options === undefined ? {} : record(where, 'options', options)) as CorkboardOptions & Record<string, unknown>;
  if (o.theme !== undefined) resolveTheme(`${where}: option "theme"`, o.theme);
  if (o.grid !== undefined) boolean(where, 'option "grid"', o.grid);
  if (o.snapping !== undefined) checkSnapping(`${where}: option "snapping"`, o.snapping);
  if (o.interaction !== undefined && typeof o.interaction !== 'boolean') {
    checkInteractionOptions(`${where}: option "interaction"`, o.interaction);
  }
  if (o.video !== undefined) checkVideoOptions(`${where}: option "video"`, o.video);
  if (o.embeds !== undefined) checkEmbedOptions(`${where}: option "embeds"`, o.embeds);
  if (o.textures !== undefined) checkTextureOptions(`${where}: option`, o.textures);
  // The zoom range itself is checked by `assertRange` in `create`, once the defaults are filled in.
  if (o.camera !== undefined) record(where, 'option "camera"', o.camera);
  if (o.cspSafe !== undefined) boolean(where, 'option "cspSafe"', o.cspSafe);
  if (o.gpuTimer !== undefined) boolean(where, 'option "gpuTimer"', o.gpuTimer);
  if (o.nonce !== undefined && typeof o.nonce !== 'string') {
    bad(where, `option "nonce" must be a string (got ${show(o.nonce)})`);
  }
  if (o.signal !== undefined && !(isObject(o.signal) && typeof o.signal.aborted === 'boolean')) {
    bad(where, `option "signal" must be an AbortSignal (got ${show(o.signal)})`);
  }
  return o;
}

// ── Camera and layout calls ──────────────────────────────────────────────────
/** The `animate` / `padding` options of the camera moves. */
export function checkMoveOptions(where: string, o: unknown): CameraMoveOptions {
  const m = record(where, 'options', o) as CameraMoveOptions & Record<string, unknown>;
  if (m.animate !== undefined) boolean(where, 'animate', m.animate);
  if (m.padding !== undefined) nonNegative(where, 'padding', m.padding);
  return m;
}

/** The options of every layout call: `animate`, `duration`, and for the grids `gap`, `columns` and `width`. */
export function checkLayoutOptions(where: string, o: unknown, grid: 'none' | 'grid' | 'masonry' = 'none'): MasonryOptions {
  const m = record(where, 'options', o) as MasonryOptions & Record<string, unknown>;
  const a: ArrangeOptions = m;
  if (a.animate !== undefined) boolean(where, 'animate', a.animate);
  if (a.duration !== undefined) nonNegative(where, 'duration', a.duration);
  if (grid !== 'none') {
    const g: GridOptions = m;
    if (g.gap !== undefined) nonNegative(where, 'gap', g.gap);
    if (g.columns !== undefined) integer(where, 'columns', g.columns, 1);
  }
  if (grid === 'masonry' && m.width !== undefined) positive(where, 'width', m.width);
  return m;
}

/** A point of the world or of the screen: both coordinates finite. */
export function checkPoint(where: string, x: unknown, y: unknown): void {
  finite(where, 'x', x);
  finite(where, 'y', y);
}
