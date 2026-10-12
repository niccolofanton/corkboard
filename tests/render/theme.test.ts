import { describe, expect, it } from 'vitest';
import {
  DARK_THEME,
  GUIDE_DARK,
  GUIDE_LIGHT,
  LIGHT_THEME,
  cssHex,
  guideColor,
  parseHex,
} from '../../src/render/theme';

describe('theme helpers', () => {
  it('parses #rrggbb only', () => {
    expect(parseHex('#ff8800')).toBe(0xff8800);
    expect(parseHex('#FF8800')).toBe(0xff8800);
    expect(parseHex('ff8800')).toBeNull();
    expect(parseHex('#f80')).toBeNull();
    expect(parseHex('red')).toBeNull();
  });

  it('formats css hex with padding', () => {
    expect(cssHex(0x000fff)).toBe('#000fff');
    expect(cssHex(0xffffff)).toBe('#ffffff');
    expect(cssHex(0)).toBe('#000000');
  });

  it('guides have their own hue per mode, apart from the selection accent', () => {
    expect(guideColor(DARK_THEME)).toBe(GUIDE_DARK);
    expect(guideColor(LIGHT_THEME)).toBe(GUIDE_LIGHT);
    expect(GUIDE_DARK).not.toBe(DARK_THEME.accent);
    expect(GUIDE_LIGHT).not.toBe(LIGHT_THEME.accent);
  });

  it('guideColor falls back to the mode default and honours an override', () => {
    expect(guideColor({ ...DARK_THEME, guide: undefined })).toBe(GUIDE_DARK);
    expect(guideColor({ ...LIGHT_THEME, guide: undefined })).toBe(GUIDE_LIGHT);
    expect(guideColor({ ...DARK_THEME, guide: 0x123456 })).toBe(0x123456);
  });
});
