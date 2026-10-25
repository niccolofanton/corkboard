// The two entry points: the root is a small designed API, `unstable` holds the building blocks. A new export
// in either is a decision, so the lists are spelled out.
// Pixi probes a 2D canvas on import; jsdom has none and would print a not-implemented error.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as root from '../src/index';
import type { AlignMode, PreviewCacheMode, SnippetNetwork, TextureOptions, VideoApi } from '../src/index';
// @ts-expect-error DebugStats is exported from /unstable only
import type { DebugStats as RootDebugStats } from '../src/index';
// @ts-expect-error overlays moved to /unstable
import type { Overlay as RootOverlay } from '../src/index';
import type { DebugStats, Overlay, OverlayContext, OverlayFactory } from '../src/unstable';
import * as unstable from '../src/unstable';

describe('root entry', () => {
  it('exports only the supported values', () => {
    expect(Object.keys(root).sort()).toEqual(
      [
        'Corkboard',
        'CorkboardError',
        'DARK_THEME',
        'DEFAULTS',
        'LIGHT_THEME',
        'MAX_SCALE',
        'MIN_SCALE',
        'SNAPSHOT_VERSION',
        'invertChange',
        'normalizeEmbedUrl',
        'parseEmbedUrl',
      ].sort(),
    );
  });

  it('exports the types hosts need to annotate their own code', () => {
    expectTypeOf<AlignMode>().toEqualTypeOf<'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom'>();
    expectTypeOf<PreviewCacheMode>().not.toBeAny();
    expectTypeOf<SnippetNetwork>().not.toBeAny();
    expectTypeOf<VideoApi['playing']>().toEqualTypeOf<ReadonlySet<string>>();
    expectTypeOf<keyof TextureOptions>().toEqualTypeOf<
      'budgetBytes' | 'workers' | 'workerUrl' | 'uploadBudgetMs' | 'overscan' | 'softCanvas'
    >();
    expectTypeOf<NonNullable<root.CorkboardOptions['textures']>>().toEqualTypeOf<TextureOptions>();
    // Referenced so the type-only imports above are used.
    expectTypeOf<RootDebugStats>().toBeAny();
    expectTypeOf<RootOverlay>().toBeAny();
  });

  it('keeps the building blocks out', () => {
    for (const name of ['Stage', 'Store', 'Interaction', 'VideoLayer', 'EmbedLayer', 'CameraApi', 'LayoutApi', 'hitTest', 'tidy']) {
      expect(name in root, name).toBe(false);
    }
  });
});

describe('unstable entry', () => {
  it('exports the building blocks and getInternals', () => {
    for (const name of [
      'getInternals',
      'Stage',
      'Store',
      'Interaction',
      'VideoLayer',
      'EmbedLayer',
      'FrameRateMonitor',
      'hitTest',
      'elementsInBox',
      'GRID',
      'tidy',
      'masonry',
      'snapMove',
      'buildSnapIndex',
      'planLive',
      'parseEmbedUrl',
      'addOverlay',
    ]) {
      expect(typeof (unstable as Record<string, unknown>)[name], name).not.toBe('undefined');
    }
  });

  it('exports the overlay and debug types', () => {
    expectTypeOf<Overlay>().not.toBeAny();
    expectTypeOf<OverlayContext>().not.toBeAny();
    expectTypeOf<OverlayFactory>().not.toBeAny();
    expectTypeOf<DebugStats['glRenderer']>().toEqualTypeOf<string>();
  });

  it('does not export the board itself', () => {
    expect('Corkboard' in unstable).toBe(false);
  });

  it('getInternals refuses what is not a board', () => {
    expect(() => unstable.getInternals({} as never)).toThrow(TypeError);
  });
});
