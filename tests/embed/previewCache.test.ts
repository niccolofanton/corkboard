// The keys of snippet previews and the store behind them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_MEMORY_MAX, PREVIEW_PERSIST_MAX, PreviewStore, hashString, previewKey } from '../../src/embed/previewCache';

afterEach(() => vi.unstubAllGlobals());

describe('hashString', () => {
  it('is stable, 64 bits wide and sensitive to every character', () => {
    expect(hashString('<b>hi</b>')).toBe(hashString('<b>hi</b>'));
    expect(hashString('<b>hi</b>')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashString('<b>hi</b>')).not.toBe(hashString('<b>ho</b>'));
    expect(hashString('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('previewKey', () => {
  it('changes with the html, the aspect bucket, the resolution and the picture size', () => {
    const base = previewKey('<i>1</i>', 31, '720p', 316, 196);
    expect(previewKey('<i>1</i>', 31, '720p', 316, 196)).toBe(base);
    for (const other of [
      previewKey('<i>2</i>', 31, '720p', 316, 196),
      previewKey('<i>1</i>', 32, '720p', 316, 196),
      previewKey('<i>1</i>', 31, '1080p', 316, 196),
      previewKey('<i>1</i>', 31, '720p', 632, 392),
    ]) {
      expect(other).not.toBe(base);
    }
  });
});

describe('PreviewStore', () => {
  const blob = (s = 'x') => new Blob([s]);

  it('keeps previews in memory, the least recently used going first', () => {
    const store = new PreviewStore('memory');
    for (let i = 0; i < PREVIEW_MEMORY_MAX; i++) store.put(`k${i}`, blob());
    expect(store.getMemory('k0')).toBeDefined();
    store.put('new', blob());
    // k0 was read, so k1 is the oldest.
    expect(store.getMemory('k1')).toBeUndefined();
    expect(store.getMemory('k0')).toBeDefined();
    store.clear();
    expect(store.getMemory('k0')).toBeUndefined();
  });

  it('is not persistent without Cache Storage, in memory mode, and reads nothing', async () => {
    vi.stubGlobal('caches', undefined);
    const store = new PreviewStore('persistent');
    expect(store.persistent).toBe(false);
    store.put('a', blob());
    expect(await store.getPersistent('a')).toBeNull();
    vi.stubGlobal('caches', { open: vi.fn() });
    expect(new PreviewStore('memory').persistent).toBe(false);
    expect(new PreviewStore('persistent').persistent).toBe(true);
  });

  it('writes under a same-origin synthetic URL and reads it back', async () => {
    const kept = new Map<string, Response>();
    const open = vi.fn(async () => ({
      match: async (u: string) => kept.get(u)?.clone(),
      put: async (u: string, r: Response) => void kept.set(u, r),
    }));
    vi.stubGlobal('caches', { open });
    const store = new PreviewStore('persistent');
    store.put('abc', blob('picture'));
    await vi.waitFor(() => expect(kept.size).toBe(1));
    expect(open).toHaveBeenCalledWith('corkboard-previews-v1');
    const url = [...kept.keys()][0];
    expect(new URL(url).origin).toBe(location.origin);
    expect(new URL(url).pathname).toBe('/__corkboard_preview/abc');
    const back = await new PreviewStore('persistent').getPersistent('abc');
    expect(back?.size).toBeGreaterThan(0);
    expect(await store.getPersistent('missing')).toBeNull();
  });

  it('does not write what came from the cache back to it', () => {
    const open = vi.fn();
    vi.stubGlobal('caches', { open });
    new PreviewStore('persistent').put('a', blob(), false);
    expect(open).not.toHaveBeenCalled();
  });

  describe('Cache Storage cap', () => {
    // Entries in insertion order, like Cache.keys() in Chromium.
    const fake = () => {
      const kept = new Map<string, Response>();
      const cache = {
        match: async (u: string) => kept.get(u)?.clone(),
        put: async (u: string, r: Response) => void kept.set(u, r),
        keys: async () => [...kept.keys()].map((url) => ({ url })),
        delete: async (r: { url: string }) => kept.delete(r.url),
      };
      vi.stubGlobal('caches', { open: async () => cache });
      const url = (k: string) => new URL(`/__corkboard_preview/${k}`, location.href).href;
      const fill = (n: number) => {
        for (let i = 0; i < n; i++) kept.set(url(`old${i}`), new Response('x'));
      };
      return { kept, url, fill };
    };

    it('deletes the oldest entries past the cap when the cache is opened', async () => {
      const c = fake();
      c.fill(PREVIEW_PERSIST_MAX + 5);
      const store = new PreviewStore('persistent');
      expect(await store.getPersistent('old3')).toBeNull();
      expect(c.kept.size).toBe(PREVIEW_PERSIST_MAX);
      expect(c.kept.has(c.url('old4'))).toBe(false);
      expect(c.kept.has(c.url('old5'))).toBe(true);
      expect(await store.getPersistent('old5')).not.toBeNull();
    });

    it('keeps the cache at the cap as it is written to, dropping the oldest', async () => {
      const c = fake();
      c.fill(PREVIEW_PERSIST_MAX);
      const store = new PreviewStore('persistent');
      store.put('fresh1', blob('a'));
      await vi.waitFor(() => expect(c.kept.has(c.url('fresh1'))).toBe(true));
      await vi.waitFor(() => expect(c.kept.size).toBe(PREVIEW_PERSIST_MAX));
      expect(c.kept.has(c.url('old0'))).toBe(false);
      expect(c.kept.has(c.url('old1'))).toBe(true);
      store.put('fresh2', blob('b'));
      await vi.waitFor(() => expect(c.kept.has(c.url('old1'))).toBe(false));
      expect(c.kept.size).toBe(PREVIEW_PERSIST_MAX);
      expect(c.kept.has(c.url('fresh2'))).toBe(true);
    });

    it('does nothing below the cap, and still stores in a cache that cannot be listed', async () => {
      const c = fake();
      c.fill(10);
      const store = new PreviewStore('persistent');
      store.put('a', blob());
      await vi.waitFor(() => expect(c.kept.has(c.url('a'))).toBe(true));
      expect(c.kept.size).toBe(11);
      const kept = new Map<string, Response>();
      vi.stubGlobal('caches', {
        open: async () => ({
          match: async (u: string) => kept.get(u)?.clone(),
          put: async (u: string, r: Response) => void kept.set(u, r),
          keys: async () => {
            throw new Error('no listing');
          },
        }),
      });
      const plain = new PreviewStore('persistent');
      plain.put('b', blob());
      await vi.waitFor(() => expect(kept.size).toBe(1));
      expect(await plain.getPersistent('b')).not.toBeNull();
    });
  });
});

