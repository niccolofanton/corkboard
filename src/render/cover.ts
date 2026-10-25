// Object-fit: cover for baked card textures. Pure, so it is testable without an OffscreenCanvas.

// A source whose shape is within this relative distance of the card's is drawn whole: the crop would be
// invisible and the bake would only lose a few edge texels.
export const COVER_EPSILON = 0.005;

export interface CoverBake {
  // Source rect to draw (a centred crop, or the whole source).
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  // Output size in texels, capped at `maxLong` on its long side and never upscaled past the source crop.
  w: number;
  h: number;
}

// `aspect` is the card's height / width (world). Without a usable one the whole source is kept.
export function coverBake(srcW: number, srcH: number, aspect: number | undefined, maxLong: number): CoverBake {
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  if (aspect !== undefined && Number.isFinite(aspect) && aspect > 0 && srcW > 0 && srcH > 0) {
    const srcAspect = srcH / srcW;
    if (Math.abs(aspect - srcAspect) / srcAspect > COVER_EPSILON) {
      if (aspect > srcAspect) sw = srcH / aspect;
      else sh = srcW * aspect;
      sx = (srcW - sw) / 2;
      sy = (srcH - sh) / 2;
    }
  }
  const k = Math.min(1, maxLong / Math.max(sw, sh));
  return {
    sx,
    sy,
    sw,
    sh,
    w: Math.max(1, Math.round(sw * k)),
    h: Math.max(1, Math.round(sh * k)),
  };
}
