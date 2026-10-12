# corkboard

An infinite canvas of image and video cards on WebGL (Pixi v8). Framework-agnostic TypeScript.

![corkboard demo](docs/screenshot.png)

- Camera: wheel / trackpad pan, pinch and ctrl+wheel zoom, drag with inertia, fit, zoom to rect, animated flights.
- On-demand render loop (0 requestAnimationFrame callbacks while idle), rbush culling, LOD textures
  (ThumbHash, atlas, own textures) decoded in workers, LRU memory budget, WebGL context-loss recovery.
- `image` and `video` cards. A video card is its poster in WebGL plus a live DOM `<video>` overlay.
- Auto layout (masonry, tidy grid, align, distribute, equal width, auto spot) and snapping (smart guides, snap to the dot grid).
- Select, marquee, drag-move and handle-resize. No undo, no collaboration.

## Quick start

```ts
import { Corkboard } from 'corkboard';

const board = await Corkboard.create(document.getElementById('board')!, { theme: 'dark' });
board.add([
  { media: { src: 'https://picsum.photos/seed/1/480/600', aspect: 1.25 } },
  { media: { src: 'https://picsum.photos/seed/2/480/270', video: 'https://example.com/clip.mp4' } },
]);
board.layout.tidy();
board.camera.fit();
board.on('selection', ({ ids }) => console.log(ids));
```

Pictures are read by a decode worker with `fetch`, so they need CORS headers. Videos only need to be playable by `<video>`.

## API

- `Corkboard.create(host, options)`: `theme`, `grid`, `snapping`, `interaction`, `video`, `textures`, `overlays`, `cspSafe`.
- Cards: `add(init | init[])`, `update(id, patch)`, `remove(ids)`, `clear()`, `get(id)`, `all()`, `size`, `inRect(rect)`, `bounds(ids?)`.
- Selection: `selection`, `select(ids)`, `selectAll()`, `clearSelection()`.
- `board.layout`: `tidy(ids?, opts)`, `masonry(ids?, opts)`, `align(mode, ids?)`, `distribute(axis, ids?)`, `equalWidth(ids?)`.
- `board.camera`: `get()`, `set(cam)`, `fit(ids?)`, `zoomTo(rect)`, `zoomBy(k)`, `actual()`, `center(x, y, scale?)`, `visible()`, `screenToWorld`, `worldToScreen`.
- Settings: `setTheme`, `setGrid`, `setSnapping({ guides, grid })`, `setVideo({ mode: 'always' | 'hover' | 'off', loop, muted })`, `setVideoPaused`.
- Events (`board.on(type, fn)` returns an unsubscribe): `selection`, `hover`, `click`, `dblclick`, `transform`, `gesture`, `delete`, `change`, `camera`, `cameraSettled`.
- `stats()`, `dispose()`. The pure layout and snapping functions, `Store`, `Stage` and `Interaction` are exported too.

A card is `{ media: { src, video?, sizes?, aspect?, thumbhash?, color? }, x?, y?, w?, h?, rot?, radius?, locked?, aspectLocked?, data? }`.
Cards with no `x` / `y` are placed on a free spot near what is on screen.

## Adding an element kind

`ElementKind` (`src/types.ts`) is a union. A new kind is one view in `src/render/views/registry.ts` and, if it needs live DOM,
one `Overlay` (`src/overlay.ts`) passed through `options.overlays`.

## Development

```sh
pnpm install
pnpm dev        # the demo (600 cards)
pnpm test
pnpm typecheck
pnpm build      # dist/ with .d.ts
```

## License

MIT
