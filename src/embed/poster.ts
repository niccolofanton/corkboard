// Fetches a poster so it is certain to be usable as a WebGL texture: read with CORS, a real image, big
// enough to be one. The result is a blob URL the decode worker can fetch (and that the layer revokes).

export const MIN_POSTER_PX = 160;

// null: not readable (no CORS, 404, not an image, or a placeholder thumbnail).
export async function fetchPoster(url: string, timeoutMs = 8000): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctl.signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      const ok = bmp.width >= MIN_POSTER_PX;
      bmp.close();
      if (!ok) return null;
    }
    return URL.createObjectURL(blob);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
