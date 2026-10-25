// Canvas colours. Pass a `Theme` to `Corkboard.create` / `board.setTheme`; `DARK_THEME` and `LIGHT_THEME`
// are ready-made.

/** Canvas colours, as 0xRRGGBB numbers. Pass one to `Corkboard.create` / `board.setTheme`; `DARK_THEME` and `LIGHT_THEME` are ready-made. */
export interface Theme {
  /** A dark canvas: picks the default guide colour and the contrast of the UI drawn on the canvas. */
  dark: boolean;
  /** Canvas background (also the WebGL clear colour). */
  canvas: number;
  /** Background dots and their opacity (kept low: the grid is a quiet guide, not a pattern). */
  dot: number;
  /** Opacity of the background dots. */
  dotAlpha?: number;
  /** Hairline around a card: baked into the textures, so a theme change rebuilds them. */
  border: number;
  /** Opacity of the hairline. */
  borderAlpha: number;
  /** Selection outline, handles and marquee. */
  accent: number;
  /** Placeholder of a card whose picture has not landed yet and that has no ThumbHash or `color`. */
  well: number;
  /**
   * Smart guides (alignment lines, spacing and size measures) and the label on their pills. Their own
   * warm hue, apart from the accent of the selection, tuned for contrast on each canvas; the mode's
   * default when absent.
   */
  guide?: number;
  /** Colour of the text on the guide pills. */
  onGuide?: number;
}

// Rose on the dark canvas (#0f0f0f, contrast 5.1:1), a deeper magenta on the light one (#f4f4f2,
// 4.5:1): a hairline in either reads at a glance, and the white semibold pill labels stay legible.
export const GUIDE_DARK = 0xf23a6a;
export const GUIDE_LIGHT = 0xd61f5f;

export function guideColor(theme: Theme): number {
  return theme.guide ?? (theme.dark ? GUIDE_DARK : GUIDE_LIGHT);
}

/** The ready-made dark theme. */
export const DARK_THEME: Theme = {
  dark: true,
  canvas: 0x0f0f0f,
  dot: 0xffffff,
  dotAlpha: 0.0805,
  border: 0xffffff,
  borderAlpha: 0.1,
  accent: 0x6aa6ff,
  well: 0x1c1c1c,
  guide: GUIDE_DARK,
  onGuide: 0xffffff,
};

/** The ready-made light theme. */
export const LIGHT_THEME: Theme = {
  dark: false,
  canvas: 0xf4f4f2,
  dot: 0x000000,
  dotAlpha: 0.1035,
  border: 0x000000,
  borderAlpha: 0.1,
  accent: 0x2f6bff,
  well: 0xe8e8e4,
  guide: GUIDE_LIGHT,
  onGuide: 0xffffff,
};

export function parseHex(s: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(s);
  return m ? parseInt(m[1], 16) : null;
}

export const cssHex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
