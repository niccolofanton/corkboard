# API reference

The surface of `@niccolofanton/corkboard`. The types in `dist/index.d.ts` are the source of truth (every member carries
JSDoc); this page is the map. Building blocks outside it live in `@niccolofanton/corkboard/unstable` (no semver guarantee).

## Create and dispose

- `await Corkboard.create(host, options)`: `host` needs a size (it is observed) and gets `position: relative` if static. Rejects with `CorkboardError('invalid')` for a bad `host` or option (nothing is made), `CorkboardError('unsupported')` without WebGL2, or with `signal.reason` if `signal` aborts first.
- `Corkboard.isSupported()`: can a WebGL2 context be made (never throws).
- `Corkboard.clearPreviewCache(name?)`: deletes the Cache Storage entry of the snippet previews (default name and the v1 one of 0.1; never throws). Open boards keep their in-memory previews.
- `board.dispose()`: idempotent. Afterwards every method throws `CorkboardError('disposed')`, except `off` (no-op) and the getters (`size`, `selection`, `video.playing`, `snapping`...), which keep the last state.

### `CorkboardOptions`

| Option | Default | |
|---|---|---|
| `theme` | `'dark'` | `'dark'`, `'light'` or a `Theme` (`DARK_THEME` / `LIGHT_THEME` are exported) |
| `grid` | `true` | Background dot grid |
| `snapping` | guides on, grid off | `{ guides, grid }`, or `false` for both off |
| `interaction` | `true` | `false`: no pointer / touch / keyboard layer (`board.interaction` is `null`); or `InteractionOptions` |
| `video` | | `VideoOptions` |
| `embeds` | | `EmbedOptions` ([Embeds](#embeds)) |
| `textures` | | `TextureOptions`: `budgetBytes` (256 MB), `workers` (a quarter of the cores, 1..4), `workerUrl`, `uploadBudgetMs` (4), `overscan` (0.5), `softCanvas` (false) |
| `camera` | `0.05..4` | `{ minScale, maxScale }`; lower the minimum for a board much wider than the screen. Needs `0 < min <= max`, else `create` rejects with `'invalid'`; `camera.setRange` changes it later |
| `cspSafe` | `false` | Pixi's CSP-safe build (no `new Function`, so no `unsafe-eval`) |
| `nonce` | | Nonce for the `<style>` elements the board injects (embed and video layers). Shared by the boards on a document, removed with the last |
| `gpuTimer` | `false` | Time each render with `EXT_disjoint_timer_query_webgl2` (`stats().render.gpuMs`, `render` event) |
| `signal` | | `AbortSignal` that cancels a pending `create` (React StrictMode). After `create` resolves it does nothing |

**Validation.** `create` checks every option before it makes anything and rejects with `CorkboardError('invalid')` naming the option: numbers must be finite and in range (`Infinity` only where "no cap" is documented: the `embeds` limits `maxLive`, `maxMounted`, `maxOffscreen`, `maxLoading`, `maxAnimating` (+ `Touch` variants) and `video.maxPlaying` / `maxPlayingTouch`), enums must be one of their values, a `Theme` needs `dark`, `canvas`, `dot`, `border`, `borderAlpha`, `accent`, `well` (colours are `0xRRGGBB` numbers). The setters below apply the same rules and throw before changing anything.

**Create-only or changeable?**

| Option | Later |
|---|---|
| `theme` | `setTheme(theme)` |
| `grid` | `setGrid(on)` |
| `snapping` | `setSnapping(s)` |
| `video` | `board.video.setOptions(o)` |
| `embeds` | `board.embeds.setOptions(o)` |
| `camera` (zoom range) | `board.camera.setRange(min, max)` |
| `interaction` as an object | `board.interaction.setOptions(o)` |
| `interaction` on / off, `textures` (all of it), `cspSafe`, `nonce`, `gpuTimer`, `signal` | create-only: make a new board to change them (`signal` only matters until `create` resolves) |

`InteractionOptions`: `select`, `emptyDrag` (`'pan'` | `'marquee'`), `keyboard`, `commit` ([controlled mode](#controlled-mode-interactioncommit-false)), `marquee` (`false`: a drag on empty canvas always pans), `keepSelectionOnPan` (a pan keeps the selection; a click that does not move clears it), `selectionOutline` (`false`: no outline or handles drawn, the host draws its own). Keyboard shortcuts act only while the board has focus, never for keys typed in an `<input>` inside the host.

`VideoOptions` (`mode: 'always'`, the default, plays cards on their own): `mode` (`'always'` | `'hover'` | `'off'`), `loop` (true), `muted` (true), `minPlayPx` (160: a card plays only if its long side is at least this on screen), `maxPlaying` (8), `maxPlayingTouch` (2); the biggest and most central cards win. The pool shares the embeds' frame budget: a slow window (under 40 fps) cuts the cap to 60% of what plays (at least 1), two smooth ones give 50% back up to `maxPlaying`. `board.video.budget` is the cap now.

## Cards

```ts
{ id?, kind?, media: { src?, video?, embed?, sizes?, aspect?, thumbhash?, color? },
  x?, y?, w?, h?, rot?, radius?, locked?, aspectLocked?, data? }
```

- `Card` (what `get` / `all` return) has every field set: `id`, `kind` (`'image'` | `'video'` | `'embed'`; default from `media`), `x y w h` (world px), `rot` (degrees, data only: no rotate gesture), `locked`, `media`, `radius`, `aspectLocked`, `data` (yours, untouched).
- `media.aspect` is height / width (the inverse of CSS `aspect-ratio`). `media.src` needs CORS (a worker fetches it). `media.embed` is `{ url }` or `{ html }` plus `title?` and `resolution?`.
- `add` and `update` copy `media` (later changes to the object you passed do not reach the card or the history) and store a `Uint8Array` thumbhash as base64, so `Card` and every `change` payload are plain JSON (`Card.media` is `CardMedia`, `thumbhash?: string`; `CardMediaInput`, the input, takes bytes or base64).
- `update(id, patch)`: a field left out or set to `undefined` is kept, except `data`: a patch with an own `data` key set to `undefined` clears it (`null` stores `null`).
- A card with no `x` / `y` is placed on a free spot near what is on screen (a lone `x` or `y` is kept); an embed with no `w` is 400 wide. `DEFAULTS` holds the default sizes.

## Methods

| Group | Members |
|---|---|
| Cards | `add(init \| init[])` returns the ids; `update(id, patch)` returns false for an unknown id; `remove(ids)` returns how many existed; `clear()`; `get(id)`; `all()` (draw order, bottom first); `size`; `inRect(rect)`; `bounds(ids?)` (`undefined` when nothing to cover); `screenRect(id)` (host-local px, `undefined` for an unknown id) |
| Draw order | `bringToFront(ids)`, `sendToBack(ids)`, `setOrder(ids)` (every id exactly once, else `'invalid'`) |
| History / sync | `applyChange(change, { invert?, source?, conflict? })`, root export `invertChange(change)` ([Undo, redo and sync](#undo-redo-and-sync)) |
| Batch | `batch(fn, { source? })`: one `change` event for everything a synchronous `fn` does; nests (the outermost named `source` wins); no rollback if it throws (the event is still emitted, `fn`'s error rethrown). Add many cards with one `add([...])`, not one by one |
| Save / load | `getSnapshot({ camera? })`, `loadSnapshot(snapshot, { camera? })`, `SNAPSHOT_VERSION` ([Save and load](#save-and-load)) |
| Selection | `selection`, `select(ids)`, `selectAll()`. No-ops with `interaction: false`. To clear: `select([])`. An "arrange" button: `board.layout.tidy(board.selection.length >= 2 ? board.selection : undefined)` |
| Settings | `setTheme('dark' \| 'light' \| Theme)`, `setGrid(on)`, `setSnapping({ guides, grid })` / `snapping` (getter, a copy); all throw `'invalid'` on a bad value |
| Events | `on(type, fn)` returns an unsubscribe; `off(type, fn)` |
| Diagnostics | `stats()` ([Stats](#stats)) |
| `board.camera` | `get()`, `set(cam)` (throws `'invalid'` unless `tx`, `ty` finite and `scale` finite > 0), `setRange(min, max)`, `fit(ids?, { animate, padding })`, `zoomTo(rect, opts)`, `zoomBy(k)`, `actual()`, `center(x, y, scale?, opts)`, `visible()`, `screenToWorld(x, y)`, `worldToScreen(x, y)`. Every number must be finite (`zoomBy(k)` and `scale` > 0, `padding` >= 0), else `'invalid'` and the camera stays put. `fit()` on an empty board does nothing; on a host with no size yet it waits for the first real one |
| `board.layout` | `tidy(ids?, { gap, columns })`, `masonry(ids?, { gap, columns, width })`, `align(mode, ids?)`, `distribute('x' \| 'y', ids?)`, `equalWidth(ids?)`; all take `{ animate, duration }`. Options are validated before anything is written (`gap` and `duration` finite >= 0, `columns` an integer >= 1, `width` finite > 0, else `'invalid'`). One `change` event with `source: 'api'`; locked cards stay put |
| `board.video` | `playing` (ids playing now), `budget`, `paused`, `setPaused(on)`, `setOptions(opts)` (validated like the `video` option) |
| `board.embeds` | `live` (ids with a mounted iframe), `interacting` (`null`: none), `info(id)` (`undefined`: not an embed card), `interact(id)`, `exitInteract()`, `setOptions(opts)` (validated like the `embeds` option) |
| `board.interaction` | `setPanMode(on)`: a hand tool, a left-button drag pans from anywhere (like Space); `setOptions(opts)`: applies at once when no gesture runs, else from the next pointer down, never to a running gesture; `null` with `interaction: false` |

Ids: every method that takes a list of ids (`remove`, `bringToFront`, `sendToBack`, `select`, `bounds`, `camera.fit`, every `layout.*`) takes `CardId | readonly CardId[]`; only `setOrder` needs the full list, as an array. Anything else (a number, `null`, an array with a non-string) throws `CorkboardError('invalid')`, never a `TypeError`.

Rectangles: `Rect` is a world rectangle by corners, `{ x0, y0, x1, y1 }` (`bounds`, `inRect`, `camera.visible`, `camera.zoomTo`). `Box` is `{ x, y, w, h }` (top-left and size), unit-neutral: `screenRect(id)` returns it in host-local CSS px (screen), and the `transform` event's `rects` are in world px. Camera moves take `CameraMoveOptions` (`animate`, `padding`); the `camera` create option is a `CameraRange` (`minScale`, `maxScale`).

Nullability: a lookup that finds nothing returns `undefined` (`get`, `screenRect`, `bounds`, `embeds.info`); a state or event field that can be "none right now" is `null` (`embeds.interacting`, `hover` / `click` / `dblclick` `id`).

## Events

`board.on(type, fn)`. The interaction events fire only with `interaction` on.

| Event | Payload |
|---|---|
| `selection` | `{ ids }` |
| `hover` | `{ id \| null }` (not on touch) |
| `click` | `{ id \| null, shift, x, y }` (x / y in world px) |
| `dblclick` | `{ id \| null, x, y }` |
| `transform` | `{ kind: 'move' \| 'resize', rects: Map<id, Box>, toFront? }` (`Box` is `{ x, y, w, h }`, here in world px): a drag, resize or nudge ended (`toFront`: the cards a drag brings to the front) |
| `gesture` | `{ kind: 'pan' \| 'marquee' \| 'drag' \| 'resize' \| 'pinch' \| null }` (`null`: ended) |
| `touch` | `{ touch: boolean }`: the pointer device changed |
| `delete` | `{ ids }`: Delete pressed on a selection (locked cards excluded); with `commit` on, the cards were removed just before this fires |
| `change` | a `Change`: `{ source, added, removed, updated: { el, prev, props }[], order? }`, the net difference, see [Change events](#change-events). One event per call, gesture commit (a drag is ONE), `batch`, `applyChange` and `loadSnapshot` |
| `render` | `{ cpuMs, gpuMs: number[] }` per rendered frame (not while idle); `gpuMs` holds GPU results that arrived meanwhile, empty without `gpuTimer` |
| `camera` | `{ camera }` every frame of a move |
| `cameraSettled` | `{ camera }` |
| `error` | `{ kind: 'texture' \| 'worker' \| 'video' \| 'embed' \| 'context', id?, url?, cause }`: a runtime failure that did not throw; the card keeps its placeholder |
| `contextLost` / `contextRestored` | `{}` (the textures reload by themselves) |
| `embedInteract` | `{ id, active }` |
| `embedLive` | `{ id, live }` |
| `embedResolved` | `{ id, provider, frameable, aspect?, title?, poster? }` (`poster` only if worth persisting: never a blob) |

## Change events

`change` is the NET difference between the board before and after one call, gesture commit, `batch` or `loadSnapshot`:

- `added`, `removed` and `updated` never share an id. In a batch: add then remove cancels; remove then add of an id is one update (`prev` is the card that was there); add then update is one add with the final card.
- `updated` entries are `{ el, prev, props }` from the FIRST `prev` to the LAST `el`. `props` are the fields that differ, compared per top-level field with `Object.is`: a `media` replaced as a whole counts as changed even if equal, `data` is compared by reference. A card back where it started is not reported; a batch with no net change emits no event.
- `order?: { moved: { id, prevBelow, nextBelow }[] }` is present whenever the draw order changed other than by cards appended on top: `bringToFront`, `sendToBack`, `setOrder`, a drag that lifts a card, a removal. A z-order change is never in `updated`. `prevBelow` / `nextBelow` are the card directly BELOW `id` (drawn just before it) before and after the change; `null` is the bottom (in `prevBelow` also "it did not exist"; in `nextBelow` also "it was removed"). `moved` is the minimal set of cards to take out and put back: every card outside the longest run that kept its relative order (O(n log n), computed only when the order changed); for `bringToFront` / `sendToBack` just the ids given. A removed card is in it with its `prevBelow`, so an undo restores its depth. A card only appended on top (the usual `add`) is not: redoing such an add puts it on top. Replay places each card directly above its `nextBelow`, bottom first. `loadSnapshot` carries `order` like any other change.
- `source`: `'user'` (a gesture), `'api'` (a call on the board or `board.layout`), `'load'` (`loadSnapshot`), `'system'` (the library itself, e.g. an embed card resized to its content) `'apply'` / `'undo'` (`applyChange`, the latter when inverted) or your own tag from `batch(fn, { source })`. When recording history or broadcasting, skip `'system'`, `'undo'` and `'apply'`. Nested batches: the outermost named source wins; `'load'` wins over any.
- A listener that throws is reported with `console.error` and does not stop the others or the board's own bookkeeping; the public `change` event goes out after the board's internal subscribers (the selection has already dropped removed cards). `batch` rethrows `fn`'s error, never a listener's. A write made by a listener is delivered after the event being delivered has reached every listener (events arrive one at a time, in order).

### Controlled mode (`interaction.commit: false`)

With `commit: false` the interaction layer NEVER writes to the board: no move, no resize, no nudge, no bring-to-front, no delete. It emits proposals and the host applies them (or not): `transform` (`rects`, and for a drag `toFront`, the cards to bring to the front, bottom first) and `delete` (`ids`, locked cards excluded). A dragged card is still drawn on top while held. With `commit` on, each gesture is ONE `change` event (`source: 'user'`) holding the move and the order; `delete` fires after the removal happened.

```ts
const board = await Corkboard.create(el, { interaction: { commit: false } });
board.on('transform', ({ rects, toFront }) => board.batch(() => {
  for (const [id, r] of rects) board.update(id, r);
  if (toFront) board.bringToFront(toFront);
}, { source: 'user' }));
board.on('delete', ({ ids }) => board.remove(ids));
```

## Undo, redo and sync

`board.applyChange(change, { invert?, source?, conflict? })` replays a `Change` (what the `change` event carries) and `invertChange(change)` (pure, from the root) computes its inverse. After a first validation pass (a bad value throws `CorkboardError('invalid')`, nothing changed) ONE batch (one event) does, in order:

1. `removed` cards are removed (ids not on the board are skipped);
2. `added` cards are upserted exactly as given: no placement, no default size, an existing id is overwritten in place;
3. `updated`: each field in `props` is written from `el` as it is (no `h` derived from the media aspect; an `undefined` field, `data` cleared, clears it). A card that is gone is skipped. With `conflict: 'skip'` a field is written only if the card still holds the value the change started from (`prev`), compared structurally (deep, JSON-like);
4. `order.moved` is replayed bottom first, each card directly above its `nextBelow` (an entry whose card or anchor is missing is skipped).

Defaults: `source` is `'undo'` when `invert` is set, else `'apply'`; `conflict` is `'skip'` when inverted, else `'overwrite'`. Camera and selection are the host's.

```ts
import { invertChange, type Change } from '@niccolofanton/corkboard';

const undo: Change[] = [];
const redo: Change[] = [];
board.on('change', (c) => {
  if (['system', 'undo', 'apply'].includes(c.source)) return;   // not new edits ('load' stays: it is undoable)
  undo.push(c);
  redo.length = 0;
});
function doUndo() { const c = undo.pop(); if (c) { board.applyChange(c, { invert: true }); redo.push(c); } }
function doRedo() { const c = redo.pop(); if (c) { board.applyChange(c); undo.push(c); } }

// Sync: send JSON.stringify(c) for 'user' / 'api' / 'load' / your own tags; the peer calls board.applyChange(JSON.parse(text)).
```

Undoing every recorded change restores the earlier boards exactly, draw order included (a fuzz test covers every write the board has), and two boards that start equal and replay the same changes stay equal. The redo of a pure append (an `add`) lands on top. `data` must be JSON-safe for the JSON round trip; `media.thumbhash` already is (base64).

## Save and load

- `getSnapshot({ camera? })` returns a `BoardSnapshot`: `{ format: 'corkboard', version: SNAPSHOT_VERSION, elements, camera? }`, cards in draw order, each with the size and position the board gave it. `camera: false` leaves the camera out.
- Saved: ids, kind, geometry, `rot`, `locked`, `aspectLocked`, `radius`, `media` (a `Uint8Array` thumbhash becomes base64), `data`, the camera. `media` is copied both ways, so a snapshot shares no object with the board; `data` is the exception, passed by reference (keep it JSON-safe). `data` is the extension slot: persist your own fields there. Any new persisted field of the library bumps `SNAPSHOT_VERSION`.
- Left out: a `blob:` URL in `media.src` / `video` / `sizes` (dead after a reload). Not included: selection, theme, grid, snapping, video and embed settings, runtime posters and snapshots, the poster an embed resolved (persist the `embedResolved` event's `poster`, or `embeds.info(id)?.posters[0]`, yourself and `update` it back: `board.update(id, { media: { ...board.get(id)!.media, src: poster } })`).
- `loadSnapshot(snapshot, { camera? })` takes the object (`JSON.parse` a saved string first). All or nothing: a version newer than this build reads throws `'invalid'` ("written by a newer corkboard"); every card goes through the same checks as `add` (`kind`, `locked` / `aspectLocked` booleans, `thumbhash` base64 or bytes, numeric fields, media, embeds), with `id x y w h media` required: every other field takes the default of `add` (`kind` comes from `media`). Unknown keys are dropped. A `data` structurally equal to the card's current one keeps the current object (like `media`), so loading the same JSON twice emits nothing. Then selection clears, a running layout animation ends, ids / positions / order are kept (nothing is auto-placed), the camera jumps to the saved one, and at most ONE `change` fires with `source: 'load'`, as a net diff: new ids `added`, gone ids `removed`, same ids `updated`, unchanged cards not reported.

## Errors

`CorkboardError` (`instanceof`, then branch on `code`):

| `code` | When |
|---|---|
| `'disposed'` | Any method after `dispose()` (not `off`, not the getters) |
| `'unsupported'` | `Corkboard.create` rejects: no WebGL2, or Pixi picked another renderer |
| `'invalid'` | `add` / `update` / `loadSnapshot` / `applyChange` got a value a card cannot hold (NaN, `w` or `h` <= 0, a duplicate id, a malformed embed, a bad snapshot or one from a newer corkboard); `setOrder` got something that is not a permutation of the ids; an id list of the wrong type; a camera or layout call with a NaN, a negative or an out-of-range value; an option (at `create` or in a `set*` / `setOptions`) that is out of range, of the wrong type or an unknown enum value (`setTheme('blue')`, `maxPlaying: NaN`, `maxLive: -1`, `textures.budgetBytes: -1`, a bad zoom range). Whatever writes a card (layout, a gesture, a resize) also refuses a NaN position or a size <= 0. The message names the call and the value, nothing was changed |

Runtime failures that do not throw (a picture or video that will not load, a dead decode worker, a failed `resolve`, a snippet that navigated away, WebGL context loss) come through the `error` event. `getInternals(notABoard)` throws a `TypeError`.

## Stats

`board.stats()` returns a `BoardStats` snapshot (call it twice a second, not every frame; use the `render` event for that):

| Group | Contents |
|---|---|
| top level | `cards`, `mounted`, `mountQueue`, `lost`, `scale`, `dpr`, `viewport` |
| `textures` | `bytes`, `budget`, `peakBytes`, `overBudgetMsMax`, `levelsMounted`, `pages`, `l2`, `l3`, `retiredPending`, `breakdown`, `queued`, `inflight`, `decodes`, `decodeMsAvg`, `fetchedBytes`, `cancelled`, `failed`, `evicted`, `uploads`, `uploadMsMax`, `uploadMsAvg`, `uploadsLastFrame` |
| `render` | `frames`, `rafCalls`, `ticks`, `tickMs` / `cpuMs` / `gpuMs` (`{ n, p50, p95, max }` or `null`), `gpuTimer` (`'off' \| 'unsupported' \| 'on'`), `renderErrors`, `renderErrorsTotal`, `hookErrors`, `firstPaintMs`, `l1CompleteMs` |
| `embeds` | `live` (mounted: active + parked), `active` (what `maxLive` caps), `maxLive`, `parked`, `culled`, `frozen`, `animating`, `animatingBudget`, `loading`, `previewsPending`, `freezeThreshold`, `interacting` |
| `video` | `playing`, `budget` |
| `debug` | `@experimental` profiling internals: `slowTicks`, `requeryMs`, `lodPassMs`, `viewPool`, `glRenderer`... (`DebugStats`, exported from `/unstable` only) |

## Embeds

```ts
const board = await Corkboard.create(el, {
  embeds: { maxLive: 12, resolve: async (url) => (await fetch(`/api/embed?url=${url}`)).json() },
});
board.add({ media: { embed: { url: 'https://youtu.be/dQw4w9WgXcQ' } } });          // nothing else to set up
board.add({ media: { embed: { url: 'https://example.com/post', title: 'A post' }, aspect: 0.75 } });
board.add({ media: { embed: { html: '<button onclick="this.textContent=1">0</button>' } } }); // a snippet
```

`EmbedOptions` (`embeds`, `board.embeds.setOptions`; `Infinity` = no cap), defaults in the [lifecycle table](HTML-EMBEDS.md#rules-and-defaults-embedoptions):

| Group | Options |
|---|---|
| Limits | `maxLive`, `maxLiveTouch`, `maxMounted`, `maxMountedTouch`, `maxOffscreen`, `maxOffscreenTouch`, `cullMargin`, `maxLoading`, `maxAnimating`, `adaptive`, `freezePx`, `minLivePx`, `minLiveScale` |
| Look | `resolution` (`'720p'` default, `'1080p'`, a short side in CSS px, `'native'`; a card's `embed.resolution` wins), `autoplay` |
| Lookup | `resolve(url)` returns `{ poster?, iframeSrc?, aspect?, title?, frameable? }`; `resolveTimeoutMs` (4000) |
| Previews | `previewWorkers` (3), `previewCache` (`'memory'`, `'persistent'`, `{ persistent: true, name }`) |
| Security | `arbitrarySameOrigin` (true), `isolatedHosts` (`[]`), `snippetNetwork` (`'images'` \| `'none'`) |

- `media.embed` is `{ url }` or `{ html }` (+ `title`). A known provider (YouTube, Vimeo, Spotify, CodePen, Figma) has its own shape and thumbnail; `parseEmbedUrl(url)` / `normalizeEmbedUrl(url)` validate user input.
- Poster, first hit wins: your `src`; `resolve(url)`; a YouTube thumbnail; a generated tile. oEmbed, `og:image`, screenshots and `X-Frame-Options` probing need a server: do them behind `resolve` and cache. `frameable: false` makes a bookmark card (never live, a double-click opens the URL in a new tab). A `resolve` that throws, rejects or times out emits `error` (`kind: 'embed'`) and the card falls back to what the URL says. `embeds.setOptions({ resolve, resolveTimeoutMs })` applies to lookups started afterwards (`resolve` cannot be unset).
- A live page is laid out at a virtual screen with the card's aspect, then scaled onto the card.
- It takes no pointer events: pan, zoom, select and drag work over it. Double-click (or Enter on a selected card) enters interact mode; Done, Esc or a click outside ends it (`embedInteract`). Keys and wheel inside a cross-origin frame never reach the page.
- Sandbox, computed at render time, never stored: providers get `allow-scripts allow-same-origin allow-forms allow-popups allow-presentation`; other URLs the same minus `allow-presentation`; snippets run in `srcdoc` with `allow-scripts` only, plus a CSP. Only http(s) URLs load. The provider allowlist is the exact embed URLs the built-in parsers emit, not whole hosts.
- Arbitrary URLs keep `allow-same-origin` (many sites break without their own cookies and storage), and the flags survive navigation inside the frame. `arbitrarySameOrigin: false` gives them an opaque origin; `isolatedHosts: ['example.com']` does it for chosen hosts only (the host or a subdomain, case-insensitive, `.example.com` is the same; it covers providers too; a change remounts the affected frames).
- **The same-origin guard is best-effort.** A frame whose starting URL is on your own origin or an `isolatedHosts` host loses `allow-same-origin`, but only the starting URL is judged: a redirect, or a link followed in interact mode, can land on your origin with scripts and its real origin. Never serve user-controlled HTML on the board's origin.
- `snippetNetwork` (default `'images'`): the snippet CSP is `default-src 'none'` with inline styles and scripts, plus `img-src data: https:` and `font-src https: data:`, so **a snippet is not offline**: a URL can carry data out. `'none'` allows only `data:` and `blob:` (no subresource requests, but best effort: a snippet can still navigate itself). A change applies to frames mounted afterwards.
- A snippet's `srcdoc` is its document. If the frame loads something else (it set `location`, a meta refresh, a link clicked in interact mode) the layer puts the `srcdoc` back and counts a strike; 3 strikes within 10 s block the card: its frame is torn down, it stays on its poster until `media.embed.html` changes, `embeds.info(id).blocked` is true and `error` (`kind: 'embed'`) is emitted. Best effort against accidents, not a security boundary.
- A `srcdoc` frame inherits the host page's CSP. A `script-src` with a nonce (or without `'unsafe-inline'`) blocks the bootstrap and the snippet's scripts: snapshots, pause and previews time out. Allow inline scripts for the page, or serve snippets from their own origin. Snapshots and previews are blob URLs: `img-src blob:`.
- A `blob:` `media.src` on an embed card (an old saved board) is treated as absent. Persist `embedResolved.poster` (an https URL), not blobs. Snapshots (SVG replies over 2 MB are dropped) and previews are never written to `media.src`.
- Previews: memory by default; `previewCache: 'persistent'` also uses Cache Storage (`corkboard-previews-v2`, or `{ persistent: true, name }`), named by the SHA-256 of the snippet and its layout. Without `crypto.subtle` (insecure context) or Cache Storage it stays in memory. `Corkboard.clearPreviewCache(name?)` empties it.

The lifecycle (live, parked, culled, frozen), defaults, previews, snapshots, pausing and the adaptive budget are in
[HTML-EMBEDS.md §11](HTML-EMBEDS.md#11-embed-lifecycle-as-implemented-2026-10-25).

## Migrating from 0.1

| 0.1 | 0.2 |
|---|---|
| `change.updated` was an array of cards | `{ el, prev, props }[]`, plus `change.source`; the event is a net diff per id, the draw order is in `change.order` ([Change events](#change-events)) |
| `stats()` was a flat `Record` (`embedsLive`, `embedsMaxLive`, `tickMs`...) | typed `BoardStats`, grouped (`embeds.live`, `render.tickMs`, `textures`, `video`, `debug`) |
| `all()` was insertion order (a brought-to-front card did not move) | draw order, bottom first (the order of `getSnapshot()`) |
| `Stage`, `Store`, `Interaction`, layout and snapping functions, embed / video layers on the root | `@niccolofanton/corkboard/unstable` |
| `board.store`, `board.stage` | private: `getInternals(board)` from `/unstable` |
| `board.embeds`, `board.interaction` were the layer objects; `CameraApi`, `LayoutApi` were classes | interfaces `EmbedsApi`, `InteractionApi`, `CameraApi`, `LayoutApi` (the removed members are in `getInternals`) |
| `add` / `update` stored whatever they got; options were not checked | `CorkboardError('invalid')` for a bad card value, option, id list, camera or layout argument; methods throw `'disposed'` after `dispose()` |
| A navigating snippet kept running | its `srcdoc` is restored; 3 navigations within 10 s block the card (poster, `error` event, `info(id).blocked`) |
| Preview cache `corkboard-previews-v1` | `-v2` (SHA-256); the v1 one is deleted when the default opens |
| Layout `ArrangeOpts` | `ArrangeGapOptions` |
| (no persistence on the board) | new: `getSnapshot(o)` / `loadSnapshot(s, o)`, `SNAPSHOT_VERSION`; a snapshot from a newer version throws |
| `setVideo(o)`, `setVideoPaused(b)`, `playing`, `videoBudget` | `board.video.setOptions(o)`, `.setPaused(b)`, `.playing`, `.budget` (and `.paused`) |
| `setEmbeds(o)` | `board.embeds.setOptions(o)`; `board.interaction.setOptions(o)` is new |
| `clearSelection()` | `select([])` |
| `arrangeTargets` | `board.selection.length >= 2 ? board.selection : undefined` |
| `options.overlays` | `addOverlay(board, factory)` from `/unstable` (returns the disposer) |
| `screenRect(id)`, `embeds.info(id)` returned `null` for a miss; `bounds()` returned `{0,0,1,1}` when empty | `undefined` for all three |
| `props: ['order']` in `updated` | `change.order: { moved: { id, prevBelow, nextBelow }[] }`; new `bringToFront`, `sendToBack`, `setOrder` |
| Hand-written undo from `change` | `board.applyChange(c, { invert: true })`, `invertChange(c)` |
| `media.thumbhash` could be a `Uint8Array` | stored as a base64 string (input still takes bytes or base64); `Card.media` is `CardMedia` |
| Types `Element`, `ElementId`, `ElementInit`, `ElementPatch`, `ElementKind`, `ElementProp`, `ElementUpdate`, `ElementMedia`, `MediaSource`, `SnapshotElement`, `SnapshotElementInput` (they shadowed the DOM's `Element` and `MediaSource`) | `Card`, `CardId`, `CardInit`, `CardPatch`, `CardKind`, `CardProp`, `CardUpdate`, `CardMedia` (stored), `CardMediaInput` (input), `SnapshotCard`, `SnapshotCardInput`. No aliases |
| `CameraOptions` (`animate`, `padding`) | `CameraMoveOptions`; the `camera` create option is the new `CameraRange`; the `{ x, y, w, h }` shape is `Box` |
| `remove` took `id \| id[]`; `select`, `bounds`, `camera.fit` and `layout.*` took arrays only | all of them take `CardId \| readonly CardId[]` (`setOrder`: the full array) |
| `board.embeds.parked`, `.culled`, `.frozen`, `.loading`, `.animating` (id sets), `.animatingBudget`, `.maxLive`, `.freezeThreshold`, `.previewsPending` | `board.stats().embeds.parked` ... (counts; `board.embeds.live` stays the id set; the other id sets are in `getInternals(board).embeds`). New: `stats().embeds.active`, the count `maxLive` caps |
| `interaction.commit: false` still lifted the dragged card and deleted on Delete | writes nothing: `transform` (with `toFront`) and `delete` are proposals; a drag with `commit` is one `change` |
| `update(id, { data: undefined })` kept `data` | clears it (an own `data` key) |
| (no `batch` on the board) | new: `batch(fn, { source })`; `ChangeSource` is `'user' \| 'api' \| 'load' \| 'system' \| string` |

## Building blocks (`/unstable`)

No semver guarantee: `Stage`, `Store`, `Interaction`, `VideoLayer`, `EmbedLayer`, `FrameRateMonitor`, the pure layout (`tidy`, `masonry`, `align`, `distribute`, `equalWidth`, `planPlacement`, `autoSpot`...) and snapping (`buildSnapIndex`, `snapMove`, `snapResize`) functions, the embed rules, `DebugStats`, and `getInternals(board)` (`{ stage, store, interaction, embeds, video, overlayRoot, ... }`, works on a disposed board too).

### Overlays

DOM overlays synced to the camera: HTML placed over the canvas (a label pinned to a card, a toolbar that follows the selection...) and kept in step with the camera every frame. Add one to a board at any time with `addOverlay(board, factory)`:

```ts
import { addOverlay } from '@niccolofanton/corkboard/unstable';
const remove = addOverlay(board, ({ root, store, stage }) => ({
  onFrame: (camChanged) => { /* sync your DOM to stage.cam.cam */ },
  dispose: () => { /* remove your DOM */ },
}));
```

`factory` gets `{ root, store, stage }` (`root` covers the canvas); the overlay's `onFrame` / `onSettle` run with the render. The returned function removes it (idempotent); `board.dispose()` removes the rest. On a disposed board `addOverlay` throws `'disposed'`; a throwing factory adds nothing.
