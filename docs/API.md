# API reference

The full surface of `@niccolofanton/corkboard`. The types in `dist/index.d.ts` are the source of truth; this page is the
map.

## Board

- `Corkboard.create(host, options)`: `theme`, `grid`, `snapping`, `interaction`, `video`, `embeds`, `textures`, `overlays`, `camera`, `cspSafe`.
- Cards: `add(init | init[])`, `update(id, patch)`, `remove(ids)`, `clear()`, `get(id)`, `all()`, `size`, `inRect(rect)`, `bounds(ids?)`.
- Selection: `selection`, `select(ids)`, `selectAll()`, `clearSelection()`.
- `board.layout`: `tidy(ids?, opts)`, `masonry(ids?, opts)`, `align(mode, ids?)`, `distribute(axis, ids?)`, `equalWidth(ids?)`.
- `board.camera`: `get()`, `set(cam)`, `fit(ids?)`, `zoomTo(rect)`, `zoomBy(k)`, `actual()`, `center(x, y, scale?)`, `visible()`, `screenToWorld`, `worldToScreen`.
- Settings: `setTheme`, `setGrid`, `setSnapping({ guides, grid })`, `setVideo({ mode: 'always' | 'hover' | 'off', loop, muted, minPlayPx, maxPlaying, maxPlayingTouch })`, `setVideoPaused`, `setEmbeds({ maxLive, maxLiveTouch, maxMounted, maxOffscreen, cullMargin, minLivePx, minLiveScale, maxLoading, freezePx, maxAnimating, adaptive, resolution, arbitrarySameOrigin, autoplay, previewWorkers, previewCache })`.
- Events (`board.on(type, fn)` returns an unsubscribe): `selection`, `hover`, `click`, `dblclick`, `transform`, `gesture`, `delete`, `change`, `camera`, `cameraSettled`, `embedInteract`, `embedLive`, `embedResolved`.
- `stats()`, `dispose()`. The pure layout and snapping functions, `Store`, `Stage` and `Interaction` are exported too.

- `textures`: `budgetBytes`, `workers`, `workerUrl`, `uploadBudgetMs`, `overscan`, `softCanvas`.
- `camera`: `minScale`, `maxScale` (default 0.05..4). A board much wider than the screen that must fit whole needs a lower minimum.
- `interaction`: `select`, `emptyDrag`, `keyboard`, `commit`, and for a host that draws its own chrome `marquee: false` (a drag
  on empty canvas always pans), `keepSelectionOnPan` (a pan keeps the selection, a click that does not move clears it) and
  `selectionOutline: false` (the canvas draws no selection outline or handles). `board.interaction.setPanMode(true)` is a hand
  tool: a left-button drag pans from anywhere, over a card included, like holding Space.
- `video` (`mode: 'always'`): a card plays on its own only if its long side is at least `minPlayPx` CSS px on screen
  (default 160), and at most `maxPlaying` play at once (default 8; `maxPlayingTouch`, default 2, on touch), the biggest and
  most central first. Smaller or surplus cards stay a thumbnail, so a zoomed-out board opens no streams. The pool shares the
  frame budget of the embeds: a slow window (under 40 fps) cuts the cap to 60% of what plays (at least 1, the most visible
  clips keep playing) and two smooth ones in a row give 50% back, up to `maxPlaying`. `board.videoBudget` is the cap now.
- `camera.fit()` on a host that has no size yet (hidden tab, pane not laid out) waits for the first real size and then
  centres, unless the camera was moved meanwhile.
- Keyboard shortcuts act only while the board itself has focus, never for keys typed in an `<input>` inside the host.

A card is `{ media: { src, video?, sizes?, aspect?, thumbhash?, color? }, x?, y?, w?, h?, rot?, radius?, locked?, aspectLocked?, data? }`.
Cards with no `x` / `y` are placed on a free spot near what is on screen (a given `x` or `y` alone is kept, and an embed
without `w` is 400 wide).

## Embeds

```ts
const board = await Corkboard.create(el, {
  embeds: { maxLive: 12, resolve: async (url) => (await fetch(`/api/embed?url=${url}`)).json() },
});
board.add({ media: { embed: { url: 'https://youtu.be/dQw4w9WgXcQ' } } });          // nothing else to set up
board.add({ media: { embed: { url: 'https://example.com/post', title: 'A post' }, aspect: 0.75 } });
board.add({ media: { embed: { html: '<button onclick="this.textContent=1">0</button>' } } }); // a snippet
```

- `media.embed` is `{ url }` or `{ html }` (+ `title`). `media.aspect` is height / width, as everywhere; a known provider has its own.
- Poster, first hit wins: your `src`; `embeds.resolve(url)` (`{ poster?, iframeSrc?, aspect?, title?, frameable? }`); YouTube
  thumbnails; a generated tile (host, title, glyph, themed). oEmbed titles / thumbnails, `og:image`, screenshots and
  `X-Frame-Options` probing need a server: do them behind `resolve` and cache the result. `frameable: false` makes a bookmark
  card (never live, a double-click opens the URL in a new tab).
- Resolution: a live page is laid out at a virtual screen with the card's aspect, then scaled onto the card, so it shows
  its desktop layout at any card size. `embeds.resolution` is `'720p'` (default: short side 720 CSS px, a 16:9 card is a
  1280 x 720 page), `'1080p'` (1920 x 1080), a number (the short side) or `'native'` (the card's world size: a 400 px card
  is a 400 px wide page). `media.embed.resolution` overrides it per card; `setEmbeds({ resolution })` changes it live.
- It does not take pointer events: pan, zoom, select and drag work over it. Double-click (or Enter on a selected card) enters
  interact mode; Done, Esc or a click outside ends it (`embedInteract`). Keys and wheel inside a cross-origin frame never reach
  the page.
- Sandbox, computed at render time and never stored: allowlisted providers get `allow-scripts allow-same-origin allow-forms
  allow-popups allow-presentation`; other URLs the same minus `allow-presentation`; snippets run in `srcdoc` with `allow-scripts`
  only plus a CSP (no network). Only http(s) URLs load. A snippet has no storage and cannot reach the page.
  The allowlist is the exact embed URLs the built-in parsers emit (`youtube-nocookie.com/embed/`, `player.vimeo.com/video/`,
  `open.spotify.com/embed/`, `codepen.io/<user>/embed/`, `figma.com/embed`), not whole hosts.
- Arbitrary URLs keep `allow-same-origin` because many sites break without their own cookies and storage. The risk: the
  sandbox flags survive navigation inside the frame, so a link followed in interact mode loads the next site with scripts
  and its real origin (it still cannot reach your page; a frame on your own origin never gets the flag). To give those frames
  an opaque origin instead, pass `embeds: { arbitrarySameOrigin: false }` (also `setEmbeds`).
- A `blob:` `media.src` on an embed card (an old saved board) is treated as absent, since it died with its page: a fresh poster
  is made for it and `embedResolved.poster` never reports a blob. A host's https / data: `media.src` stays the poster of a
  tile or fetched thumbnail; a snapshot or preview of a snippet, which is the real picture, goes over it. Neither is written
  to `media.src`. Persist `embedResolved.poster` (an https URL), not blobs, when you save a board.
- Live state: `board.embeds.live`, `board.embeds.interacting`, `board.embeds.interact(id)`, `board.embeds.info(id)`.

The lifecycle (live, parked, culled, frozen), its options and defaults, previews, snapshots, pausing and the adaptive
budget are in [HTML-EMBEDS.md §11](HTML-EMBEDS.md#11-embed-lifecycle-as-implemented-2026-10-25).

## Adding an element kind

`ElementKind` (`src/types.ts`) is a union. A new kind is one view in `src/render/views/registry.ts` and, if it needs live DOM,
one `Overlay` (`src/overlay.ts`) passed through `options.overlays`.
