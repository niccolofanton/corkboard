# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.2.0]

### Breaking

- The root entry is a small designed API: `Corkboard`, `CorkboardError`, the themes, `DEFAULTS`, `MIN_SCALE`, `MAX_SCALE`, `parseEmbedUrl`, `normalizeEmbedUrl` and the types a host needs. `Stage`, `Store`, `Interaction`, the video and embed layers and the pure layout and snapping functions moved to `@niccolofanton/corkboard/unstable` (no semver guarantee).
- `board.store` and `board.stage` are private: use `getInternals(board)` from `/unstable`. `board.camera`, `board.layout`, `board.embeds` and `board.interaction` are typed as the interfaces `CameraApi`, `LayoutApi`, `EmbedsApi` (`live`, `interacting`, `info`, `interact`, `exitInteract`) and `InteractionApi` (`setPanMode`); `CameraApi` and `LayoutApi` are no longer classes.
- The `change` event is the net difference per card id: `added`, `removed` and `updated` never share an id (add then remove cancels, remove then add is one update, add then update is one add), `updated` is `{ el, prev, props }[]` (it was an array of cards; `props` compares each top-level field with `Object.is`), a batch with no net change emits nothing. It carries `source` (`'user' | 'api' | 'load' | 'system' | string`) and, when the draw order changed other than by an append, `order: { moved: { id, prevBelow, nextBelow }[] }`: anchors (the card directly below each moved card before and after), the minimal set of cards to take out and put back, not whole id lists. A removed card is in it, so an undo restores its depth.
- Removed from the root: `setVideo`, `setVideoPaused`, `playing`, `videoBudget` (now `board.video`), `setEmbeds` (`board.embeds.setOptions`), `clearSelection` (`select([])`), `arrangeTargets`, `CorkboardOptions.overlays` (`addOverlay` in `/unstable`), `DebugStats` (now `/unstable`, and `BoardStats.debug` is `@experimental`). `snapping` returns a copy.
- `screenRect(id)`, `bounds(ids?)` and `embeds.info(id)` return `undefined` when there is nothing to return (`bounds` no longer returns a unit rect on an empty board). A lookup miss is `undefined`; a "none right now" field is `null`.
- `camera.set` throws `'invalid'` for a non-finite `tx` / `ty` or a `scale` <= 0, and the `camera` option for anything but `0 < minScale <= maxScale` (no silent fallback).
- `stats()` returns a typed, grouped `BoardStats` (`textures`, `render`, `debug`, `embeds`, `video`) instead of a flat record; `embedsLive` / `embedsMaxLive` are `embeds.live` / `embeds.maxLive`, and the old timing series are `render.tickMs` / `cpuMs` / `gpuMs` percentiles.
- `all()` returns the cards in draw order, bottom first.
- `Card.media.thumbhash` (0.1: `Element`) is stored as a base64 string: `add`, `update` and `applyChange` convert a `Uint8Array`, so cards and `change` payloads are JSON-safe. `Card.media` is the new `CardMedia`; `CardMediaInput`, the input, still takes bytes or base64. `add` and `update` copy `media`.
- `interaction.commit: false` writes nothing to the board: no lift of the dragged card, no delete, no move. `transform` (with the new `toFront`) and `delete` are proposals for the host to apply (controlled mode, documented in the API reference). With `commit` on, `delete` fires after the removal.
- `update(id, { data: undefined })` with an own `data` key clears `data` (it used to keep it).
- `add` and `update` validate their input (0.1 stored whatever it got) and throw `CorkboardError('invalid')` (NaN, a size <= 0, a duplicate id, an embed with both or neither of `url` / `html`...); `loadSnapshot` and `applyChange` apply the same rules. Every method but `off` and the getters throws `CorkboardError('disposed')` after `dispose()`. `Corkboard.create` rejects with `CorkboardError('unsupported')` without WebGL2.
- A snippet frame that loads another document is given its `srcdoc` back; 3 such navigations within 10 s block the card (poster, `error` event, `embeds.info(id).blocked`) until its content changes. Best effort against accidents (a link clicked in interact mode), not a security boundary.
- The snippet preview cache is `corkboard-previews-v2`, keyed by SHA-256; opening the default cache deletes the v1 one. Persistent previews need `crypto.subtle` (otherwise memory only).
- The pure layout `ArrangeOpts` (`{ gap }`) is `ArrangeGapOptions`, so `ArrangeOptions` means one thing.
- Public types renamed, no aliases (the old `Element` and `MediaSource` shadowed the DOM globals in a consumer's module). The declarations (root and `/unstable`) show only the new names:

  | 0.1 | 0.2 |
  |---|---|
  | `Element`, `ElementId`, `ElementInit`, `ElementPatch`, `ElementKind`, `ElementProp`, `ElementUpdate` | `Card`, `CardId`, `CardInit`, `CardPatch`, `CardKind`, `CardProp`, `CardUpdate` |
  | `ElementMedia` (stored), `MediaSource` (input) | `CardMedia`, `CardMediaInput` |
  | `SnapshotElement`, `SnapshotElementInput` | `SnapshotCard`, `SnapshotCardInput` |
  | `CameraOptions` (`animate`, `padding` of `fit` / `zoomTo` / `center`) | `CameraMoveOptions`; the `camera` create option is typed `CameraRange` (new) |
  | the inline `{ x, y, w, h }` of `screenRect` and `transform.rects` | `Box` (new, unit-neutral: screen px for `screenRect`, world px for `transform.rects`; `Rect` stays the world `{ x0, y0, x1, y1 }`) |
  | `Box` of `/unstable` (`{ minX, minY, maxX, maxY }`, world px) | `Aabb` (frees `Box` for the root x/y/w/h type) |

- Every list of ids takes `CardId | readonly CardId[]`: `remove`, `bringToFront` and `sendToBack` already did; now `select`, `bounds`, `camera.fit` and every `board.layout` method do too. `setOrder` needs the full list as an array. A value of another type throws `CorkboardError('invalid')` (`board.select('id')` used to throw `ids.filter is not a function`).
- Options are validated, at `create` and in every setter, with `CorkboardError('invalid')` naming the option: `setTheme('blue')` (was a raw `TypeError`) and `create({ theme: 'blue' })` (was accepted), `video.setOptions({ maxPlaying: NaN })`, `embeds.setOptions({ maxLive: -1 })`, `textures.budgetBytes: -1`, enum values, booleans, a `Theme` with a missing field. Numbers must be finite and in range; `Infinity` only where "no cap" is documented (the `embeds` limits, `video.maxPlaying`). API reference: which options are create-only (`textures`, `cspSafe`, `nonce`, `gpuTimer`, `signal`, `interaction` on / off) and which can change later.
- `stats().embeds.maxLive` caps the new `stats().embeds.active` (active frames), not `live` (active + parked, as before); its documentation said otherwise. The demo HUD shows `active/maxLive`.
- `board.embeds.parked`, `culled`, `frozen`, `loading`, `animating`, `animatingBudget`, `maxLive`, `freezeThreshold` and `previewsPending` (members of the 0.1 layer object) are `board.stats().embeds.*` (counts; the id sets are in `getInternals(board).embeds`).

### Added

- `CorkboardError` (`code`: `'disposed' | 'unsupported' | 'invalid'`) and `Corkboard.isSupported()`.
- Save and load (the board had none in 0.1): `getSnapshot({ camera? })` returns a `BoardSnapshot`, `loadSnapshot(snapshot, { camera? })` replaces the board with it (all or nothing, at most one `change` event with `source: 'load'`); `SNAPSHOT_VERSION`. A snapshot from a newer corkboard than the build reads is refused; `loadSnapshot` follows the change rules (same ids become updates, unchanged cards are not reported) and checks cards with the same rules as `add`. Snapshots share no object with the board (`media` is copied; `data` stays by reference).
- `batch(fn, { source? })`: one `change` event for everything `fn` does, tagged with `source` (the outermost named one wins; `'load'` wins over any). Library-initiated writes are `'system'`: skip them in an undo stack, do not broadcast them. If `fn` throws, its error is the one rethrown.
- Z-order: `bringToFront(ids)`, `sendToBack(ids)`, `setOrder(ids)`, and `change.order` so an undo can restore depth.
- `board.applyChange(change, { invert?, source?, conflict? })` and the pure `invertChange(change)`: undo, redo and sync from the `change` payload (the `Change` type), in one batch. Removals, exact upserts of added cards, raw field writes (no size derived from the media; `data` cleared), then the draw order from the anchors. Inverted changes skip fields edited since; sources `'apply'` and `'undo'`; `ChangeSource`, `OrderChange`, `OrderMove`, `CardMedia` and `BoardSnapshotInput` are exported. A fuzz test undoes and redoes random operation sequences, and keeps two boards in sync through JSON.
- Namespaces: `board.video` (`playing`, `budget`, `paused`, `setPaused`, `setOptions`), `board.embeds.setOptions`, `board.interaction.setOptions` (never alters a running gesture), `camera.setRange(min, max)`.
- `addOverlay(board, factory)` in `/unstable`: DOM overlays at any time after `create`, with a disposer.
- Argument checks on the whole API: `board.layout` options (`gap`, `width`, `columns`, `duration`...) and `align` / `distribute` modes, `camera.center` / `zoomBy` / `zoomTo` / `fit` / coordinate conversions, `inRect`, `setGrid`, `setSnapping` throw `'invalid'` for a NaN, a negative or a wrong type before anything moves (`layout.tidy(ids, { gap: NaN })` wrote NaN positions that `loadSnapshot(getSnapshot())` then rejected; `masonry({ width: -50 })` stored a negative width). Whatever writes a card (layout, a drag, a resize, the embed layer) refuses a NaN or infinite position, a rotation that is not finite and a size <= 0; a layout is all or nothing. A fuzz test runs random layout calls, with bad options too.
- Root types `CameraRange`, `CameraMoveOptions`, `Box`, `AlignMode`, `SnippetNetwork`, `PreviewCacheMode`, `TextureOptions` and `VideoApi`.
- A listener that throws (`change` or any other event) is reported with `console.error` and no longer stops the other listeners or the board's own bookkeeping; the public `change` goes out after the internal subscribers.
- Events: `error` (`BoardErrorEvent`: a picture, worker, video or embed that failed), `contextLost`, `contextRestored`, `render` (`{ cpuMs, gpuMs }` per rendered frame).
- Options: `signal` (cancel a pending `create`, for React StrictMode), `nonce` (for a nonce-based `style-src`; the injected styles are shared by the boards on a document and removed with the last one).
- Embed security options: `snippetNetwork` (`'images'` | `'none'`), `isolatedHosts`, `previewCache: { persistent: true, name }`; `Corkboard.clearPreviewCache(name?)`; `resolve` and `resolveTimeoutMs` through `embeds.setOptions`.
- `@niccolofanton/corkboard/unstable` and `getInternals(board)`.
- JSDoc on every public type, so IDE hovers work on the published declarations.
- A Playwright smoke test on real WebGL (`pnpm test:e2e`), and a CI matrix over the pinned and the latest Pixi 8.x.

### Fixed

- A drag is ONE `change` event: the lift at drag start no longer writes to the store (the card is drawn on top while held, and the move and the bring-to-front are committed together on release; a cancelled drag writes nothing).
- `loadSnapshot` keeps the board's `data` object when the loaded one is structurally equal (as it already did for `media`): loading the same JSON twice emits nothing. A hand-written snapshot needs only `id`, `x`, `y`, `w`, `h` and `media`: `kind` and the rest default as in `add`. A `load` change carries `order` too, so undoing it restores the depth.
- The documented `embeds.info(id)?.poster` example did not compile (`ResolvedEmbed.posters` is an array); the docs now use the `embedResolved` event's `poster` or `posters[0]`.
- The decode worker's Blob is made when the first worker starts, not when the library is imported. Importing only `parseEmbedUrl` or the themes no longer pulls in the board or Pixi.
- The Pixi render group flag the texture retirement forces a batch rebuild with is only set when it exists; otherwise a child is added to and removed from the world.
- The texture upload uses Pixi's public API when the private members it leans on are missing (a Pixi minor renaming them).
- A dead decode worker no longer stalls its cards: its in-flight jobs move to the other workers, and with none left the failure is reported once.
- `Stage.create` honours the `signal` after each await and releases what it made; `Stage.dispose` runs every step even if one throws (the texture manager and the Pixi app are always released).
- A failed `Stage.create` or `Corkboard.create` gives everything back (canvas, GL context, ticker, workers, overlay root); a constructor step that fails no longer leaks the stage, and a dispose step that throws no longer skips the others.
- Pixi falling back to WebGPU, a 2D canvas or a WebGL1 context is a clear `'unsupported'` error.
- `Store.add` is all or nothing on a duplicate id; many updates to one card in a batch fold in linear time.
- The public texture-upload fallback (used when Pixi's private members are missing) wrote atlas cells and generated mipmaps on the active texture unit instead of the page's, so after a batch that used several units a card could show another card's picture. The page is now unbound and rebound on unit 0 before every upload; the e2e suite adds cards in rounds with different colours on both upload paths and checks every card's pixels.
- Moving the board in the DOM reloads a snippet's frame; that is detected by the iframe getting a new window and never counts as a navigation.
- `embeds.info(id)` returns `frameable: false, blocked: true` for a blocked snippet (new `ResolvedEmbed.blocked`), cleared when the card's content changes.
- `isolatedHosts` entries are normalised (host or URL, `*.` / leading dot, port, IDN, trailing dot, IPv6). IP literals match exactly and are never a suffix (`0.1` no longer isolates `127.0.0.1`). Entries that are not a host throw `CorkboardError('invalid')` from `create` / `setOptions`.
- The embed layer's automatic resize from a resolver's aspect is a `'system'` change.
- The generated placeholder of an HTML snippet is grey, without a glyph.
- A write made inside a `change` listener reaches the later listeners after the change that caused it, not before: `Store` and the board's emitter deliver one event at a time, in order, and queue what a listener emits (a listener forwarding changes to a peer used to see `[update, add]`).
- `applyChange` refuses a change that repeats an id in `added`, in `removed` or in `updated`, or has an id both added and removed, with `'invalid'` and nothing changed (it used to remove, emit, then throw). With `invert: true` the inverse is what is validated: the `removed` cards as whole cards and the `prev` values that would land; a malformed change is a `CorkboardError('invalid')`, never a `TypeError`.
- `deepEqual` (used to keep the board's own `media` / `data` objects) reads own keys only, so `{}` and `{ constructor: 'x' }` differ (`loadSnapshot` dropped such a `data` key), and compares shared or self-referencing values in time linear in their size.
- `media.thumbhash` validation rejects padded base64 that does not decode (`"AA="`, `"AAA=="`).
- A card added while a drag holds others draws below them (it used to share the held card's rank). Disposing the interaction layer, or `loadSnapshot`, during a drag cancels it: no stale lift or pin, and the release no longer writes the old position over the loaded board.
- Removing many cards one id at a time in one `batch` no longer costs a pass over the whole draw order each (50k cards, 3k removals: 2.6 s to 0.02 s).

### Docs and tooling

- The 0.1.0 entry and the README claimed a rotate gesture; there is none (`rot` is data only).
- API reference: a navigating snippet gets its `srcdoc` back and is blocked after 3 strikes in 10 s (it said "destroyed on the first reload"); the migration guide lists only what 0.1 had; the Overlays section describes `addOverlay` for DOM synced to the camera instead of pointing at `src/`; migration rows for the `board.embeds.*` counters and the type renames. The demo's version badge is read from `package.json`.
- HTML-EMBEDS: Security section rewritten (navigation guard, `csp` attribute, advisory `snippetNetwork`, separate-origin isolation as future work).
- Release hygiene: `test:e2e` always builds a separate e2e bundle (`dist-e2e`) first. The test hook `__corkboardForcePublicUpload` is compiled out of the published bundle (`__CORKBOARD_TEST__`) and no longer declared as a `global` in the published types (it was a local cast already); `check:package` fails if either the `.js` or the `.d.ts` files carry it. `prepublishOnly` also runs `check:package` and the e2e suite. The CI e2e job runs on Chromium and Firefox, with both Pixi versions.

### Security

- Snippets: `snippetNetwork: 'none'` is best effort. It blocks subresource requests (images, fonts, `fetch`...), but a snippet can still navigate its own frame (`location.href = 'https://x/?…'`) and that request always leaves; `'none'` is advisory. On engines other than Chromium a hostile snippet can run another page in its frame, outside the snippet CSP; only serving snippets from a separate origin would isolate them (future work). Snapshot replies over 2 MB are dropped.
- Snippets: in Chromium the iframe carries the snippet CSP in its `csp` attribute (Embedded Enforcement), so a page a snippet navigates to is not run unless it sends `Allow-CSP-From`.
- `isolatedHosts` removes `allow-same-origin` for chosen hosts. The same-origin guard (this one and the own-origin one) looks only at the URL a frame starts with: a redirect or a link followed in interact mode can leave it.
- The persistent preview cache key is a SHA-256 (it was a 64-bit hash).
- Documented: a `srcdoc` snippet inherits the host page's CSP; `worker-src blob:` / `textures.workerUrl`, `cspSafe` and `nonce` cover a strict CSP.

## [0.1.0]

First release, published as `@niccolofanton/corkboard`.

### Added

- Infinite WebGL canvas of image, video and embed cards on Pixi v8 (`pixi.js` ^8.22.0 as a peer dependency), with pan, zoom and an on-demand render loop (no `requestAnimationFrame` callbacks while nothing moves).
- Viewport culling through an rbush index, so cards outside the view cost nothing.
- Level-of-detail image pipeline: ThumbHash placeholder, shared atlas, per-card textures with baked rounded corners, decoded in a worker pool under an LRU memory budget.
- Video cards: a WebGL poster plus a `<video>` element synced to the camera, with a play pool (`always` / `hover` / `off`) that adapts to the frame rate.
- Embed cards for YouTube, Vimeo, Spotify, CodePen, Figma, any page or a snippet of HTML: a poster sprite that becomes a sandboxed iframe at a virtual 720p / 1080p screen, with live / parked / culled lifecycle, runtime posters and snapshots.
- Auto layout (masonry, tidy grid, align, distribute, equal width) with animated transitions.
- Interaction: selection and marquee, drag and resize, smart-guide and dot-grid snapping, keyboard shortcuts, hand tool.
- Typed events (`selection`, `hover`, `click`, `dblclick`, `transform`, `gesture`, `delete`, `change`, `camera`, `cameraSettled`, `embedInteract`, `embedLive`, `embedResolved`) and a `stats()` API.
- Extension points: custom element kinds (views and DOM overlays), light / dark theme, optional CSP-safe mode.
- Single bundled `dist/index.d.ts` that resolves under `node16`, `nodenext` and `bundler` module resolution.
- Decode worker inlined as a blob worker; also exported as `@niccolofanton/corkboard/decode.worker.js` for pages whose CSP forbids blob workers (`textures.workerUrl`).
