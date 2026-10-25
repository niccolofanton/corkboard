# Corkboard

[![npm](https://img.shields.io/npm/v/@niccolofanton/corkboard)](https://www.npmjs.com/package/@niccolofanton/corkboard)
[![CI](https://github.com/niccolofanton/corkboard/actions/workflows/ci.yml/badge.svg)](https://github.com/niccolofanton/corkboard/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@niccolofanton/corkboard)](LICENSE)

![Corkboard](docs/preview.gif)

An infinite WebGL canvas of image, video and embed cards, built on Pixi v8. Framework-agnostic TypeScript, made for
boards of thousands of cards on an ordinary laptop.

- **Fast by not working:** on-demand render loop (idle at 0 rAF callbacks), viewport culling, level-of-detail textures
  decoded in workers under a memory budget.
- **Video and embeds:** videos play over their WebGL poster; YouTube, Vimeo, Spotify, CodePen, Figma, any page or a
  snippet of HTML become sandboxed live iframes, loaded in chunks, frozen to a snapshot when too small to read.
- **Layout and editing:** masonry, tidy grid, align and distribute with animated transitions; selection, drag, resize,
  rotate, smart guides and grid snapping.

**Live demo: [corkboard.niccolofanton.dev](https://corkboard.niccolofanton.dev)**

## Install

```sh
npm i @niccolofanton/corkboard pixi.js
```

`pixi.js` ^8.22.0 is a peer dependency. ESM only, types included. Needs WebGL2.

## Quick start

```ts
import { Corkboard } from '@niccolofanton/corkboard';

async function main(): Promise<void> {
  const board = await Corkboard.create(document.getElementById('board')!, { theme: 'dark' });
  board.add([
    { media: { src: 'https://picsum.photos/seed/1/480/600', aspect: 1.25 } },
    { media: { src: 'https://picsum.photos/seed/2/480/270', video: 'https://example.com/clip.mp4' } },
    { media: { embed: { url: 'https://youtu.be/dQw4w9WgXcQ' } } },
    { media: { embed: { html: '<button onclick="this.textContent++">0</button>' } } },
  ]);
  board.layout.tidy();
  board.camera.fit();
  board.on('selection', ({ ids }) => console.log(ids));
}
void main();
```

- Pictures are fetched by a worker, so they need CORS headers.
- `Corkboard.create` is async; a top-level `await` also works if your build target allows it (Vite: `build.target: 'es2022'`).
- Embeds don't take pointer events: double-click (or Enter) to interact, Esc to leave. A known provider needs no setup;
  for titles, thumbnails and framing checks of other pages, pass `embeds.resolve` (see the [API reference](docs/API.md#embeds)).

## Strict CSP

The decode worker is inlined and started from a blob URL. If your CSP forbids blob workers, serve the bundled worker and
pass its URL; if it forbids `unsafe-eval`, add `cspSafe: true`:

```ts
import workerUrl from '@niccolofanton/corkboard/decode.worker.js?url'; // Vite; any bundler that gives you a file URL
await Corkboard.create(el, { textures: { workerUrl }, cspSafe: true });
```

## Docs

- [API reference](docs/API.md): methods, options, events, embeds.
- [HTML embeds](docs/HTML-EMBEDS.md): how embeds are loaded, culled, frozen and paused (§11), and the research behind it.
- [Renderer handoff](docs/HANDOFF.md): stage, culling, LOD textures, atlas, video, layout, snapping, performance.

## Development

```sh
pnpm install
pnpm dev        # demo
pnpm test
pnpm build      # dist/: library, bundled types, decode worker
```

## License

MIT
