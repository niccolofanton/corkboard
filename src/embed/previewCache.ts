// Where the previews of snippet cards are kept, so a snippet is rendered once: an in-memory map shared by
// the layer, and optionally the Cache Storage API, which survives a reload (opt-in: it leaves pictures of
// the visitor's snippets on disk). Nothing else is ever stored.
//
// A preview is keyed by what decides its picture: the snippet's HTML, the aspect it is laid out at
// (bucketed), the virtual screen and the size it is drawn at. The memory map is per page and uses a cheap
// 64-bit hash of that; the persistent store outlives the page, so its entries are named by the SHA-256 of it
// (a collision would show one snippet's picture on another card, for good).

/** `-v2`: the entries of `-v1` were named by a different hash and can never be read again. */
export const PREVIEW_CACHE_NAME = 'corkboard-previews-v2';
const LEGACY_CACHE_NAME = 'corkboard-previews-v1';
/** Previews kept in memory (the oldest go first). A preview is a few tens of KB. */
export const PREVIEW_MEMORY_MAX = 400;
/**
 * Previews kept in Cache Storage. Past this the oldest are deleted, in the order `Cache.keys()` returns them,
 * which is insertion order in Chromium (the other engines are not relied on: there the cap still holds, but
 * the entries dropped may not be the oldest).
 */
export const PREVIEW_PERSIST_MAX = 1000;

/**
 * Where the rendered previews of HTML snippets are kept. `'memory'`: this page only. `'persistent'`: also in Cache Storage,
 * under the default name. `{ persistent: true, name }`: the same, in the Cache Storage entry `name` (to keep several boards apart, or to clear one without touching the others).
 */
export type PreviewCacheMode = 'memory' | 'persistent' | { persistent: true; name?: string };

/**
 * FNV-1a over UTF-16 code units. Two runs with different offset bases give 64 bits, so two snippets are
 * not taken for each other by chance.
 */
export function hashString(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** What decides a preview, as one string: the persistent store hashes it with SHA-256, the memory map with FNV. */
export function previewMaterial(html: string, bucket: number, resolution: string, w: number, h: number): string {
  return `${resolution}|${bucket}|${w}x${h}|${html}`;
}

export function previewKey(html: string, bucket: number, resolution: string, w: number, h: number): string {
  return hashString(previewMaterial(html, bucket, resolution, w, h));
}

// SHA-256 as hex, null where `crypto.subtle` is missing (it only exists in secure contexts).
async function sha256Hex(s: string): Promise<string | null> {
  try {
    const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle;
    if (!subtle) return null;
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(s)));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return hex;
  } catch {
    return null;
  }
}

const hasSubtle = (): boolean => typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function';

/**
 * Deletes the Cache Storage entry of the previews (default: the default name, and the one an older version
 * used). Resolves when done; never throws, and does nothing where Cache Storage does not exist.
 */
export async function clearPreviewCache(name: string = PREVIEW_CACHE_NAME): Promise<void> {
  if (typeof caches === 'undefined') return;
  const names = name === PREVIEW_CACHE_NAME ? [name, LEGACY_CACHE_NAME] : [name];
  for (const n of names) {
    try {
      await caches.delete(n);
    } catch {
      // Nothing to clear, or not allowed.
    }
  }
}

export class PreviewStore {
  private readonly memory = new Map<string, Blob>();
  // null: Cache Storage is not usable here (private mode, file://, no support): memory only from then on.
  private cache: Promise<Cache | null> | null = null;
  // Entries in Cache Storage as far as this page knows: counted when it was opened, then +1 per write.
  private stored = 0;
  private wantsPersistent = false;
  private name = PREVIEW_CACHE_NAME;

  constructor(mode: PreviewCacheMode) {
    this.mode = mode;
  }

  get mode(): PreviewCacheMode {
    return this.wantsPersistent ? { persistent: true, name: this.name } : 'memory';
  }

  set mode(m: PreviewCacheMode) {
    this.wantsPersistent = m !== 'memory';
    const name = typeof m === 'object' && m.name ? m.name : PREVIEW_CACHE_NAME;
    // Another cache: opened (and counted) again on the next use.
    if (name !== this.name) {
      this.name = name;
      this.cache = null;
      this.stored = 0;
    }
  }

  // Whether `getPersistent` can find anything: asked for, Cache Storage exists, and there is a SHA-256 to name
  // the entries with (an insecure context has none: memory only then).
  get persistent(): boolean {
    return this.wantsPersistent && typeof caches !== 'undefined' && hasSubtle();
  }

  getMemory(key: string): Blob | undefined {
    const b = this.memory.get(key);
    if (b) {
      // Recently used stays.
      this.memory.delete(key);
      this.memory.set(key, b);
    }
    return b;
  }

  // `material`: what `previewMaterial` made the key from.
  async getPersistent(material: string): Promise<Blob | null> {
    try {
      if (!this.persistent) return null;
      const name = await sha256Hex(material);
      if (name === null) return null;
      const cache = await this.open();
      const res = await cache?.match(urlOf(name));
      const blob = res ? await res.blob() : null;
      return blob && blob.size > 0 ? blob : null;
    } catch {
      return null;
    }
  }

  // `material`: also write it to Cache Storage, named by its SHA-256 (not when it came from there).
  put(key: string, blob: Blob, material?: string): void {
    this.memory.delete(key);
    this.memory.set(key, blob);
    while (this.memory.size > PREVIEW_MEMORY_MAX) this.memory.delete(this.memory.keys().next().value as string);
    if (material !== undefined && this.persistent) void this.putPersistent(material, blob);
  }

  clear(): void {
    this.memory.clear();
  }

  private async putPersistent(material: string, blob: Blob): Promise<void> {
    try {
      const name = await sha256Hex(material);
      if (name === null) return;
      const cache = await this.open();
      if (!cache) return;
      await cache.put(urlOf(name), new Response(blob, { headers: { 'content-type': blob.type || 'image/webp' } }));
      if (++this.stored > PREVIEW_PERSIST_MAX) await this.trim(cache);
    } catch {
      // Quota, private mode: the preview just is not kept.
    }
  }

  private open(): Promise<Cache | null> {
    if (this.cache === null) {
      this.cache = (async () => {
        try {
          if (typeof caches === 'undefined') return null;
          // The cache of an older version can never be read again: dropped (not when it was asked for by name).
          if (this.name !== LEGACY_CACHE_NAME) void Promise.resolve(caches.delete?.(LEGACY_CACHE_NAME)).catch(() => undefined);
          const cache = await caches.open(this.name);
          await this.trim(cache);
          return cache;
        } catch {
          return null;
        }
      })();
    }
    return this.cache;
  }

  // Deletes the oldest entries past the cap. A cache that cannot list or delete is still a cache.
  private async trim(cache: Cache): Promise<void> {
    try {
      const keys = await cache.keys();
      const excess = keys.length - PREVIEW_PERSIST_MAX;
      for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
      this.stored = Math.min(keys.length, PREVIEW_PERSIST_MAX);
    } catch {
      // Not listable: no cap, as before.
    }
  }
}

// A same-origin URL that only names the entry; nothing is ever fetched from it.
const urlOf = (key: string): string => new URL(`/__corkboard_preview/${key}`, location.href).href;
