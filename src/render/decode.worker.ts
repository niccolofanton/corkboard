// Decode worker: fetch -> decode -> downscale -> bake the rounded corners -> hand back an
// ImageBitmap (transferred, zero copy). Corners are baked here so cards stay plain sprites that
// batch with no masks or custom shaders 
import { thumbHashToRGBA } from 'thumbhash';
import { coverBake } from './cover';
import type { DecodeRequest, WorkerIn, WorkerOut } from './decode.protocol';

declare const self: DedicatedWorkerGlobalScope;

const inflight = new Map<number, AbortController>();

function bake(
  src: ImageBitmap | ImageData,
  srcW: number,
  srcH: number,
  req: DecodeRequest,
): { bitmap: ImageBitmap; w: number; h: number } {
  // Crop to the card's shape first (cover), so the sprite can be the card's size with no stretch and the
  // corners baked below stay on the card's edge.
  const { sx, sy, sw, sh, w, h } = coverBake(srcW, srcH, req.aspect, req.maxLong);
  const canvas = new OffscreenCanvas(w, h);
  // A GPU-backed canvas by default: its bitmap reaches the main context without a CPU round trip and
  // the whole load is ~2x faster than with `willReadFrequently` (software canvas, `soft: true`),
  // measured on the 1,000-card board. The cost is a one-off 'GPU stall due to ReadPixels' notice.
  const ctx = canvas.getContext('2d', {
    willReadFrequently: req.soft === true,
  }) as OffscreenCanvasRenderingContext2D;
  // Constant radius in WORLD px, so it is `radiusWorld * (texels per world px)` texels.
  const radius = Math.max(
    0,
    Math.min(Math.min(w, h) / 2, (req.radiusWorld * Math.max(w, h)) / req.worldLong),
  );
  ctx.beginPath();
  if (radius > 0.5) ctx.roundRect(0, 0, w, h, radius);
  else ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (src instanceof ImageData) {
    const tmp = new OffscreenCanvas(srcW, srcH);
    (tmp.getContext('2d') as OffscreenCanvasRenderingContext2D).putImageData(src, 0, 0);
    ctx.drawImage(tmp, sx, sy, sw, sh, 0, 0, w, h);
  } else {
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  }
  if (req.border) {
    // The hairline: stroke the clip path itself, twice as wide as wanted since the clip
    // keeps the inner half. One texel is about one device px at every level, so it stays a hairline.
    ctx.strokeStyle = req.border;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  return { bitmap: canvas.transferToImageBitmap(), w, h };
}

async function load(req: DecodeRequest, signal: AbortSignal): Promise<void> {
  const t0 = performance.now();
  let fetched = 0;
  let out: { bitmap: ImageBitmap; w: number; h: number };
  if (req.level === 0 && req.hash) {
    const { w, h, rgba } = thumbHashToRGBA(req.hash);
    const data = new ImageData(new Uint8ClampedArray(rgba), w, h);
    out = bake(data, w, h, req);
  } else {
    const res = await fetch(req.url as string, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    fetched = blob.size;
    const bmp = await createImageBitmap(blob);
    try {
      out = bake(bmp, bmp.width, bmp.height, req);
    } finally {
      bmp.close();
    }
  }
  if (signal.aborted) {
    out.bitmap.close();
    throw new DOMException('aborted', 'AbortError');
  }
  const msg: WorkerOut = {
    op: 'done',
    rid: req.rid,
    bitmap: out.bitmap,
    w: out.w,
    h: out.h,
    fetched,
    decodeMs: performance.now() - t0,
  };
  self.postMessage(msg, [out.bitmap]);
}

self.onmessage = (e: MessageEvent<WorkerIn>): void => {
  const m = e.data;
  if (m.op === 'cancel') {
    inflight.get(m.rid)?.abort();
    return;
  }
  const ac = new AbortController();
  inflight.set(m.rid, ac);
  load(m, ac.signal)
    .catch((err: unknown) => {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      const msg: WorkerOut = {
        op: 'fail',
        rid: m.rid,
        reason: err instanceof Error ? err.message : String(err),
        aborted,
      };
      self.postMessage(msg);
    })
    .finally(() => inflight.delete(m.rid));
};
