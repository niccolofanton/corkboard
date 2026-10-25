import { expect, test, type Page } from '@playwright/test';

// The built library on a real (software) WebGL2 context: textures reach the GPU, cards are drawn, embeds mount,
// dispose cleans up. Run twice: with the fast upload path (Pixi private members) and with the public fallback.

type Rect = { x: number; y: number; w: number; h: number };
type Rgb = [number, number, number];

declare global {
  interface Window {
    Corkboard: any;
    __board: any;
    __errors: unknown[];
    __firstId: string;
  }
}

// Colour of the page at (x, y) in a screenshot: decoded in the page, so the test needs no PNG library.
async function pixelAt(page: Page, x: number, y: number): Promise<Rgb> {
  const png = (await page.screenshot({ clip: { x: 0, y: 0, width: 800, height: 600 } })).toString('base64');
  return page.evaluate(
    async ([b64, px, py]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(px as number, py as number, 1, 1).data;
      return [d[0], d[1], d[2]] as Rgb;
    },
    [png, Math.round(x), Math.round(y)] as const,
  );
}

// Colours of the page at many points, from one screenshot.
async function pixelsAt(page: Page, points: readonly (readonly [number, number])[]): Promise<Rgb[]> {
  const png = (await page.screenshot({ clip: { x: 0, y: 0, width: 800, height: 600 } })).toString('base64');
  return page.evaluate(
    async ([b64, pts]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      return (pts as [number, number][]).map(([x, y]) => {
        const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return [d[0], d[1], d[2]] as Rgb;
      });
    },
    [png, points as [number, number][]] as const,
  );
}

const dist = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

for (const mode of ['fast', 'fallback'] as const) {
  test(`renders image cards and embeds on real WebGL (${mode} upload path)`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await page.goto(mode === 'fallback' ? '/?fallback=1' : '/');
    await page.waitForFunction(() => (window as any).__ready === true);

    expect(await page.evaluate(() => window.Corkboard.isSupported())).toBe(true);

    // Board with three solid-colour cards, laid out in a row.
    const ids: number[] = await page.evaluate(async () => {
      const host = document.getElementById('host')!;
      window.__errors = [];
      const board = await window.Corkboard.create(host, { grid: false });
      window.__board = board;
      board.on('error', (e: unknown) => window.__errors.push(e));
      const base = location.origin;
      const ids = board.add(['red', 'green', 'blue'].map((c, i) => ({
        x: i * 260,
        y: 0,
        w: 240,
        h: 180,
        media: { src: `${base}/img/${c}.png`, aspect: 180 / 240 },
      })));
      board.camera.fit(undefined, { animate: false });
      return ids;
    });
    expect(ids).toHaveLength(3);
    expect(await page.locator('#host canvas').count()).toBe(1);

    // Textures reach the GPU: poll the stats (read defensively, the field set is not part of the contract).
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            // `stats()` is a diagnostics blob whose shape moves (flat once, nested under `textures` now): add up
            // the upload counter and the texture bytes wherever they sit.
            const sum = (o: unknown): number => {
              if (!o || typeof o !== 'object') return 0;
              let t = 0;
              for (const [k, v] of Object.entries(o)) {
                if (typeof v === 'number' && ['uploads', 'bytes', 'textureBytes'].includes(k)) t += v;
                else if (v && typeof v === 'object' && k !== 'slowTicks') t += sum(v);
              }
              return t;
            };
            return sum(window.__board.stats());
          }),
        { message: 'textures uploaded' },
      )
      .toBeGreaterThan(0);

    const rects: Rect[] = await page.evaluate((ids) => ids.map((id) => window.__board.screenRect(id)), ids);
    const bg = await pixelAt(page, 4, 590);
    const expected: Rgb[] = [
      [230, 30, 30],
      [30, 200, 30],
      [30, 60, 230],
    ];
    for (let i = 0; i < 3; i++) {
      const r = rects[i];
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      // The real picture, not the placeholder: wait for its colour to land.
      await expect
        .poll(async () => dist(await pixelAt(page, cx, cy), expected[i]), { message: `card ${i} shows its picture` })
        .toBeLessThan(60);
      expect(dist(await pixelAt(page, cx, cy), bg)).toBeGreaterThan(60);
    }

    // An HTML snippet embed mounts an iframe in the host.
    await page.evaluate(() => {
      window.__board.add({ x: 0, y: 260, media: { embed: { html: '<p>hi</p>' } }, w: 400 });
      window.__board.camera.fit(undefined, { animate: false });
    });
    await expect(page.locator('#host iframe').first()).toBeAttached();

    const errors = await page.evaluate(() => window.__errors);
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    // The fallback announces itself once; the fast path never does (so each run proves the path it names).
    expect(warnings.filter((w) => w.includes('falling back to the public'))).toHaveLength(mode === 'fallback' ? 1 : 0);

    // dispose() takes the canvas (and everything else) out of the host.
    await page.evaluate(() => window.__board.dispose());
    await expect(page.locator('#host canvas')).toHaveCount(0);
    await expect(page.locator('#host iframe')).toHaveCount(0);
  });
}

// Cards that arrive in rounds, each with a colour of its own, on a camera that shows many small cards (the shared
// 128 px atlas pages) and a few big ones (own textures) at once, so a batch binds several texture units. Every
// upload into an atlas page must reach that page: after a batch that used units 0 and 1, the active unit is 1, and
// an upload that trusts Pixi's bound-texture cache ends up in the texture on unit 1 (a card showing another card's
// colour). Checked in both upload paths.
const ROUNDS = 6;
const PER_ROUND = 40;
for (const mode of ['fast', 'fallback'] as const) {
  test(`keeps every card's own picture while cards arrive in rounds (${mode} upload path)`, async ({ page }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(mode === 'fallback' ? '/?fallback=1' : '/');
    await page.waitForFunction(() => (window as any).__ready === true);
    await page.evaluate(async () => {
      window.__errors = [];
      const board = await window.Corkboard.create(document.getElementById('host')!, { grid: false });
      window.__board = board;
      board.on('error', (e: unknown) => window.__errors.push(e));
    });

    // The colour of card k: the hue steps by the golden angle, so neighbours and the cards of a round differ a lot.
    const colorOf = (k: number): Rgb => {
      const h = ((k * 137.508) % 360) / 60;
      const v = 0.45 + 0.4 * ((k * 7) % 5) / 4;
      const f = (n: number) => Math.round(255 * v * (1 - 0.9 * Math.max(0, Math.min(1, Math.abs(((h + n) % 6) - 3) - 1))));
      return [f(0), f(4), f(2)];
    };
    const total = ROUNDS * (PER_ROUND + 1);
    const ids: number[] = [];
    const colors: Rgb[] = [];

    const check = async (upto: number) => {
      const rects: Rect[] = await page.evaluate((ids) => ids.map((id) => window.__board.screenRect(id)), ids.slice(0, upto));
      const px = await pixelsAt(page, rects.map((r) => [r.x + r.w / 2, r.y + r.h / 2] as const));
      return px.map((c, i) => dist(c, colors[i])).map((d, i) => (d < 40 ? -1 : i)).filter((i) => i >= 0);
    };

    for (let round = 0; round < ROUNDS; round++) {
      // One big card and a block of small ones; solid-colour pictures made here (blob: URLs, decoded by the workers).
      // The big one last: drawn after the small ones, so a batch starts with an atlas page (unit 0) and goes on to the big card's texture (unit 1).
      const specs = [...Array.from({ length: PER_ROUND }, () => ({ big: false })), { big: true }].map((s, j) => {
        const k = round * (PER_ROUND + 1) + j;
        const color = colorOf(k);
        colors.push(color);
        return { ...s, k, color };
      });
      const added: number[] = await page.evaluate(
        async ({ specs, round }) => {
          const urls = await Promise.all(
            specs.map(async (s) => {
              const c = document.createElement('canvas');
              c.width = 256;
              c.height = 192;
              const ctx = c.getContext('2d')!;
              ctx.fillStyle = `rgb(${s.color.join(',')})`;
              ctx.fillRect(0, 0, 256, 192);
              return URL.createObjectURL(await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png')));
            }),
          );
          // Big cards: three across in a band above the small ones. Small cards: 20 across, two rows per round.
          const els = specs.map((s, j) => {
            const media = { src: urls[j], aspect: 192 / 256 };
            if (s.big) return { x: (round % 3) * 760, y: -1400 + Math.floor(round / 3) * 600, w: 700, h: 525, media };
            const n = j;
            return { x: (n % 20) * 120, y: round * 2 * 100 + Math.floor(n / 20) * 100, w: 100, h: 75, media };
          });
          const ids = window.__board.add(els);
          window.__board.camera.fit(undefined, { animate: false });
          return ids;
        },
        { specs, round },
      );
      ids.push(...added);
      // Let this round land (cards of the earlier rounds are on screen too, and must keep their colours). Not an
      // assertion by itself: the verdict is the check after the last round.
      await expect
        .poll(async () => (await check(ids.length)).length, { timeout: 6_000, message: `round ${round}` })
        .toBeLessThan(1)
        .catch(() => undefined);
    }
    expect(ids).toHaveLength(total);

    // Everything is in: each card shows its own colour, and nothing else was painted over it.
    await expect.poll(async () => (await check(total)).length, { timeout: 10_000 }).toBe(0);
    expect(await page.evaluate(() => window.__errors)).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.evaluate(() => window.__board.dispose());
  });
}

// Snippet frames: moving the board in the DOM reloads every iframe (in a new window), which must not look like a
// navigation; a snippet that keeps navigating its frame away is put back to its document, then torn down to its
// poster after 3 strikes within 10 s (the layer's navigation guard).
test('tells a snippet that navigates away from a frame that merely reloads', async ({ page }) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ready === true);
  await page.evaluate(async () => {
    window.__errors = [];
    const board = await window.Corkboard.create(document.getElementById('host')!, { grid: false });
    window.__board = board;
    board.on('error', (e: any) => window.__errors.push({ kind: e.kind, id: e.id, message: String(e.cause?.message ?? e.cause) }));
    window.__firstId = board.add({ x: 0, y: 0, w: 300, h: 200, media: { embed: { html: '<p id="stay">stay</p>' } } })[0];
    board.camera.fit(undefined, { animate: false });
  });
  const ready = page.locator('#host .cb-embed[data-ready] iframe');
  await expect(ready).toHaveCount(1);

  // The host moves the board, over and over: each time the iframe is a new browsing context (a new
  // `contentWindow`) that reloads its srcdoc. That is no navigation: more moves than strikes, and the card stays
  // live and unblocked.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const host = document.getElementById('host')!;
      const wrap = document.createElement('div');
      document.body.appendChild(wrap);
      wrap.appendChild(host);
    });
    await page.waitForTimeout(300);
  }
  await expect(page.locator('#host iframe')).toHaveCount(1);
  expect(await page.evaluate(() => window.__errors)).toEqual([]);
  expect(await page.evaluate(() => window.__board.embeds.info(window.__firstId)?.blocked)).toBeUndefined();

  // A snippet that sends its frame elsewhere is not our document any more: gone from the DOM, and reported.
  await page.evaluate(() => {
    window.__board.add({ x: 0, y: 260, w: 300, h: 200, media: { embed: { html: '<script>setTimeout(function () { location.replace("about:blank"); }, 200);</script>' } } });
    window.__board.camera.fit(undefined, { animate: false });
  });
  await expect.poll(() => page.evaluate(() => window.__errors.length), { timeout: 15_000 }).toBe(1);
  expect(await page.evaluate(() => window.__errors)).toEqual([
    { kind: 'embed', id: expect.any(String), message: 'snippet navigated away from its document' },
  ]);
  await expect(page.locator('#host iframe')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
  await page.evaluate(() => window.__board.dispose());
});

// Chromium's Embedded Enforcement: the snippet's iframe carries its CSP in the `csp` attribute, and the bootstrap
// (pause, snapshot) works under it.
test('a snippet frame under the csp attribute still pauses and freezes', async ({ page }) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ready === true);
  await page.evaluate(async () => {
    window.__errors = [];
    const board = await window.Corkboard.create(document.getElementById('host')!, { grid: false });
    window.__board = board;
    board.on('error', (e: any) => window.__errors.push({ kind: e.kind, id: e.id, message: String(e.cause?.message ?? e.cause) }));
    board.add({
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      media: { embed: { html: '<div style="background:#c33;height:100vh">tick</div><script>window.n = 0; setInterval(function () { window.n++; }, 20);</script>' } },
    });
    board.camera.fit(undefined, { animate: false });
  });
  const ifr = page.locator('#host .cb-embed[data-ready] iframe');
  await expect(ifr).toHaveCount(1);
  expect(await ifr.getAttribute('csp')).toContain("default-src 'none'");
  expect(await ifr.getAttribute('sandbox')).toBe('allow-scripts');
  const frame = page.frames().find((f) => f !== page.mainFrame())!;
  // Alive: the snippet's script runs under the policy.
  await expect.poll(() => frame.evaluate(() => (window as any).n)).toBeGreaterThan(5);

  // Zoomed far out the card is small: its frame is paused, snapshotted into the poster and hidden.
  await page.evaluate(() => window.__board.camera.set({ tx: 300, ty: 250, scale: 0.25 }));
  await expect(page.locator('#host .cb-embed[data-frozen]')).toHaveCount(1, { timeout: 20_000 });
  const n = await frame.evaluate(() => (window as any).n);
  await page.waitForTimeout(500);
  expect(await frame.evaluate(() => (window as any).n)).toBe(n);
  expect(await page.evaluate(() => window.__errors)).toEqual([]);
  expect(pageErrors).toEqual([]);
  await page.evaluate(() => window.__board.dispose());
});

// A snippet that sends its frame to another page (a link clicked in interact mode, `location.href = ...`): the
// layer puts its document back, and a snippet that keeps doing it is blocked. Chromium also refuses to run the
// other page at all (the csp attribute); engines without Embedded Enforcement run it, which is why that part of the
// test is Chromium only. The request itself leaves either way.
test('puts a snippet back after it navigates its frame away, and blocks one that keeps doing it', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const requests: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/evil')) requests.push(u.pathname);
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ready === true);
  const evil = 'http://localhost:4179/evil.html';
  await page.evaluate(async () => {
    window.__errors = [];
    (window as any).__msgs = [];
    addEventListener('message', (e) => (window as any).__msgs.push(String(e.data)));
    const board = await window.Corkboard.create(document.getElementById('host')!, { grid: false });
    window.__board = board;
    board.on('error', (e: any) => window.__errors.push({ kind: e.kind, id: e.id, message: String(e.cause?.message ?? e.cause) }));
  });
  const msgs = () => page.evaluate(() => (window as any).__msgs as string[]);

  // Control: a plain sandboxed frame with no csp attribute does run the other page (so the check below means something).
  await page.evaluate((evil) => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.src = evil;
    f.style.display = 'none';
    document.body.appendChild(f);
  }, evil);
  await expect.poll(msgs).toContain('evil-ran');
  await page.evaluate(() => {
    (window as any).__msgs.length = 0;
    document.querySelector('body > iframe')!.remove();
  });
  requests.length = 0;

  // 1. A link followed in interact mode: the other page does not run (Chromium), and the snippet's document is back.
  const id = await page.evaluate((evil) => {
    const [id] = window.__board.add({
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      media: {
        embed: {
          html: `<script>parent.postMessage('boot', '*');</script><a id="go" href="${evil}" style="display:block;width:300px;height:200px">go</a>`,
        },
      },
    });
    window.__board.camera.fit(undefined, { animate: false });
    return id;
  }, evil);
  const ifr = page.locator('#host .cb-embed[data-ready] iframe');
  await expect(ifr).toHaveCount(1);
  await expect.poll(msgs).toContain('boot');
  await page.evaluate((id) => window.__board.embeds.interact(id), id);
  const frame = page.frames().find((f) => f !== page.mainFrame())!;
  await frame.click('#go');
  // Put back: the snippet boots again, the card is live and not blocked.
  const boots = async () => (await msgs()).filter((m) => m === 'boot').length;
  await expect.poll(boots, { timeout: 15_000 }).toBe(2);
  await page.waitForTimeout(500);
  expect(await boots()).toBe(2);
  if (browserName === 'chromium') expect(await msgs()).toEqual(['boot', 'boot']);
  expect(requests).toContain('/evil.html');
  if (browserName === 'chromium') expect(requests).not.toContain('/evil-ran');
  await expect(ifr).toHaveCount(1);
  expect(await page.evaluate((id) => window.__board.embeds.info(id)?.blocked, id)).toBeUndefined();
  expect(await page.evaluate(() => window.__errors)).toEqual([]);
  await page.evaluate((id) => window.__board.remove([id]), id);
  await expect(page.locator('#host iframe')).toHaveCount(0);

  // 2. A snippet that navigates itself again and again: put back twice, blocked on the third.
  await page.evaluate(() => ((window as any).__msgs.length = 0));
  requests.length = 0;
  const id2 = await page.evaluate((evil) => {
    const [id] = window.__board.add({
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      media: { embed: { html: `<script>parent.postMessage('boot', '*'); setTimeout(function () { location.href = '${evil}'; }, 300);</script>` } },
    });
    window.__board.camera.fit(undefined, { animate: false });
    return id;
  }, evil);
  await expect.poll(() => page.evaluate(() => window.__errors.length), { timeout: 20_000 }).toBe(1);
  expect(await page.evaluate(() => window.__errors)).toEqual([
    { kind: 'embed', id: id2, message: 'snippet navigated away from its document' },
  ]);
  await expect(page.locator('#host iframe')).toHaveCount(0);
  expect(await page.evaluate((id) => window.__board.embeds.info(id), id2)).toMatchObject({ kind: 'html', frameable: false, blocked: true });
  expect((await msgs()).filter((m) => m === 'boot')).toHaveLength(3);
  expect(requests.filter((r) => r === '/evil.html').length).toBeGreaterThanOrEqual(3);
  if (browserName === 'chromium') {
    expect(requests).not.toContain('/evil-ran');
    expect(await msgs()).not.toContain('evil-ran');
  }
  // Changing the content makes it a fresh card.
  await page.evaluate((id) => window.__board.update(id, { media: { embed: { html: '<p>fresh</p>' } } }), id2);
  await expect(page.locator('#host iframe')).toHaveCount(1);
  expect(await page.evaluate((id) => window.__board.embeds.info(id)?.blocked, id2)).toBeUndefined();
  expect(pageErrors).toEqual([]);
  await page.evaluate(() => window.__board.dispose());
});
