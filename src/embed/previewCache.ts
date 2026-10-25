// Where the previews of snippet cards are kept, so a snippet is rendered once: an in-memory map shared by
// the layer, and optionally the Cache Storage API, which survives a reload (opt-in: it leaves pictures of
// the visitor's snippets on disk). Nothing else is ever stored.
//
// A preview is keyed by a hash of what decides its picture: the snippet's HTML, the aspect it is laid out at
// (bucketed), the virtual screen and the size it is drawn at.

export const PREVIEW_CACHE_NAME = 'corkboard-previews-v1';
// Previews kept in memory (the oldest go first). A preview is a few tens of KB.
export const PREVIEW_MEMORY_MAX = 400;
// Previews kept in Cache Storage. Past this the oldest are deleted, in the order `Cache.keys()` returns them,
// which is insertion order in Chromium (the other engines are not relied on: there the cap still holds, but
// the entries dropped may not be the oldest).
export const PREVIEW_PERSIST_MAX = 1000;

export type PreviewCacheMode = 'memory' | 'persistent';

// FNV-1a over UTF-16 code units. Two runs with different offset bases give 64 bits, so two snippets are
// not taken for each other by chance.
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

export function previewKey(html: string, bucket: number, resolution: string, w: number, h: number): string {
  return hashString(`${resolution}|${bucket}|${w}x${h}|${html}`);
}

export class PreviewStore {
  private readonly memory = new Map<string, Blob>();
  // null: Cache Storage is not usable here (private mode, file://, no support): memory only from then on.
  private cache: Promise<Cache | null> | null = null;
  // Entries in Cache Storage as far as this page knows: counted when it was opened, then +1 per write.
  private stored = 0;

  constructor(public mode: PreviewCacheMode) {}

  // Whether `getPersistent` can find anything.
  get persistent(): boolean {
    return this.mode === 'persistent' && typeof caches !== 'undefined';
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

  async getPersistent(key: string): Promise<Blob | null> {
    try {
      const cache = await this.open();
      const res = await cache?.match(urlOf(key));
      const blob = res ? await res.blob() : null;
      return blob && blob.size > 0 ? blob : null;
    } catch {
      return null;
    }
  }

  // `persist`: also write it to Cache Storage (not when it came from there).
  put(key: string, blob: Blob, persist = true): void {
    this.memory.delete(key);
    this.memory.set(key, blob);
    while (this.memory.size > PREVIEW_MEMORY_MAX) this.memory.delete(this.memory.keys().next().value as string);
    if (persist && this.mode === 'persistent') void this.putPersistent(key, blob);
  }

  clear(): void {
    this.memory.clear();
  }

  private async putPersistent(key: string, blob: Blob): Promise<void> {
    try {
      const cache = await this.open();
      if (!cache) return;
      await cache.put(urlOf(key), new Response(blob, { headers: { 'content-type': blob.type || 'image/webp' } }));
      if (++this.stored > PREVIEW_PERSIST_MAX) await this.trim(cache);
    } catch {
      // Quota, private mode: the preview just is not kept.
    }
  }

  private open(): Promise<Cache | null> {
    if (this.cache === null) {
      this.cache = (async () => {
        try {
          const cache = typeof caches === 'undefined' ? null : await caches.open(PREVIEW_CACHE_NAME);
          if (cache) await this.trim(cache);
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
