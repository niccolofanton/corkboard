# Handoff: a moodboard canvas that holds 1,000+ image cards at display refresh rate

How the original app renders its infinite moodboard canvas (PixiJS v8 / WebGL, plain TypeScript, no React in
the hot path), written so another project can reuse the approach. Everything below was built and measured in
the original app; file names refer to its `src/board/` tree and are given so you know what to copy, not
because you need access to it.

Scope: renderer (stage, camera, culling, LOD, textures, views), video overlays, background grid, layout
engine, snapping and guides, captions, perf harness. Out of scope: sync/collaboration, persistence, the
toolbar/UI chrome, presence cursors.

## 0. Summary of the approach

| Decision | Choice | Why |
|---|---|---|
| Renderer | Pixi v8, WebGL only (`preference: 'webgl'`), one canvas | Sprites batch; the camera is one GPU transform |
| Camera | World `Container({ isRenderGroup: true })`, set `position` + `scale` | Pan/zoom never rebuilds instructions: ~0.1 to 0.5 ms CPU per frame for 1,000 sprites |
| Loop | Hand-rolled on-demand rAF; Pixi ticker, system ticker, GC and event system OFF | Idle = 0 rAF callbacks, 0 % CPU |
| Culling | Own R-tree (`rbush`) over world AABBs; views exist only near the viewport | Pixi has no culling worth using at this scale; a view is expensive to build, cheap to pool |
| Images | 4 LOD levels (ThumbHash, tiny atlas cell, own texture 480 px, own texture 1600 px) | Texture memory follows what is on screen, not board size |
| Corners | Baked into the bitmap in a decode worker | Cards stay plain sprites: no masks, no custom shaders, one batch |
| Video | Poster in WebGL, one DOM `<video>` laid over the card, transform-synced | Browsers decode video far better than WebGL texture uploads; DOM video is free hardware decode |
| Layout | Pure functions in world space (masonry, tidy, align, snap) | Testable, deterministic, reusable by ghosts, export and AI tooling |
| State | Immutable element objects in a store with a change stream | Stage diffs by identity, defers work to the next tick |

Headline results (1,000 image cards, 2560x1600 @2x, M1 Pro, 120 Hz display): rAF p95 8.7 to 9.3 ms (the
vsync interval itself), stage tick CPU p95 0.3 to 1.5 ms, GPU p95 1.4 to 3.3 ms, **0 React commits** during
interaction, JS heap flat over 10 pan cycles, idle 0 rAF. 2,000 cards: same frame times.

## 1. Architecture

```
                         ┌──────────────────────── per rAF tick (only while something moves/loads) ────────────────────────┐
 input (wheel/drag/pinch)│                                                                                                  │
   │  coalesced pointer  │  beforeHooks → driver → camera.step(dt) → flushStore → [camera moved?]                            │
   ▼                     │                                              │                │                                  │
 CameraController ───────┤                                              │         applyCamera(): world.position/scale,       │
 (tx, ty, scale,         │                                              │         bg tile transform                          │
  version++)             │                                              ▼                                                    │
                         │      BoardStore ──change events──► pending sets (added/removed/updated/cards)                      │
 BoardStore              │      (elements,                              │                                                    │
 (immutable elements,    │       rbush, draw order)        cullAndLod() every 100 ms during a gesture, exact on settle:      │
  rbush, rank)           │            ▲                       ├─ requery(): rbush.searchInto(window)  → mount queue           │
   ▲                     │            │ searchInto/rank        ├─ lodPass(): pickLevel per card → WantedItem[]                 │
   │ ops                 │            │                        └─ TextureManager.setWanted(): queue / cancel decode requests   │
 tools / sync            │                                              │                                                    │
                         │      drainMounts() (≤5 ms: cards first, nearest first, views from pools)                          │
                         │      TextureManager.frame(≤4 ms): upload decoded ImageBitmaps → repoint sprites → enforceBudget    │
                         │      overlay.draw() (selection, guides)   screenLayers.draw()   frameHooks (DOM overlays sync)     │
                         │      if dirty: app.render() → TextureManager.afterRender() (deferred destroy)                      │
                         └──────────────────────────────────────────────────────────────────────────────────────────────────┘
                                       │ keep rAF while: camera busy | decoded bitmaps pending | lodDirty | mountQueue | animating layers
                                       ▼ else: lastTs = 0; one setTimeout(140 ms) = settle()
  settle(): exact cullAndLod(settled=true) + flush retired textures + settleHooks (React-safe 'cameraSettled' event)

 decode workers (clamp(cores/4,1,4)) ◄── load{level,url|thumbhash,maxLong,radiusWorld} ──  TextureManager
   fetch → createImageBitmap → OffscreenCanvas clip(roundRect)+draw+hairline → transferToImageBitmap ──► main thread (wakes the loop)

 DOM overlays (video, text editor): transform-synced in frameHooks, same rAF as the render
```

**Per frame (cheap, bounded):** camera step, pending store changes, `applyCamera`, a LOD pass at most every
100 ms, ≤5 ms of view mounting, ≤4 ms of texture uploads, overlay draw, one `render()`.
**On settle (140 ms after the camera stops):** the exact re-query and LOD pass, deferred texture teardown
flush, settle hooks (the only place React state may change), mip/raster refinements (text re-raster at
exactly zoom x dpr).

Module map (copy list in section 11):

| Module | Role |
|---|---|
| `render/stage.ts` | `BoardStage`: Pixi app, loop, culling, LOD pass, view mounting, previews/overrides, theme |
| `render/camera.ts` | `CameraController`: pan, eased cursor-anchored zoom, drag inertia, fly-to. No DOM, no Pixi |
| `render/textures.ts` | `TextureManager`: levels, atlases, worker pool, uploads, LRU, retirement, reset |
| `render/atlas.ts`, `lod.ts`, `lru.ts`, `retire.ts` | Pure bookkeeping (unit-testable without GL) |
| `render/decode.worker.ts`, `decode.protocol.ts` | Fetch, decode, downscale, bake corners, transfer bitmap |
| `render/views/*` | One pooled view class per element kind (`PostView` is the card) |
| `render/overlay.ts`, `guides.ts` | Screen-space selection, handles, smart guides |
| `overlay/video*.ts`, `ambient*.ts` | DOM video overlays and play policy |
| `layout/*`, `interact/snapping.ts`, `geometry.ts`, `hitTest.ts` | Pure math |
| `store/doc.ts`, `store/caption.ts` | rbush index + draw order; caption geometry |

## 2. Pixi v8 setup, loop and culling

### 2.1 Application init

```ts
Ticker.system.autoStart = false; Ticker.system.stop();   // its GC scheduler keeps a rAF loop alive forever
await app.init({
  resolution: devicePixelRatio, autoDensity: true, antialias: false,
  preference: 'webgl', powerPreference: 'high-performance',
  autoStart: false, sharedTicker: false,
  gcActive: false,                                        // our LRU owns texture lifetimes (see 3.7)
  eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
});
app.ticker.stop();
```

- `stage.eventMode = 'none'` everywhere. Input is plain DOM listeners on the host element and hit testing is
  our own (rbush + exact per-kind test, section 6.6). Pixi's event system walks the scene on every move.
- `antialias: false`: edges that matter are baked into textures or drawn as device-pixel hairlines.
- Scene: `stage → [bg TilingSprite, world (render group), previewLayer (render group, same camera), overlay (screen space)]`.
  `world.sortableChildren = true`; each view's `zIndex` = its rank in the store's draw order.
- If your page forbids `eval`, import `pixi.js/unsafe-eval` (the default shader/uniform generators use `new Function`).
- **Pin the exact Pixi version.** Partial atlas uploads use the renderer's private texture-system state
  (see 3.5); re-check `textures.ts` on every Pixi upgrade. The original pinned 8.22.0.

### 2.2 On-demand loop (idle = 0 rAF)

`requestFrame()` is the only way to schedule work: it schedules one rAF if none is pending and cancels the
settle timer. Everything that can change what is on screen calls it: camera input, store events, worker
messages (`onWake`), view asynchronous completions (`ctx.wake`), overlay state changes, resize, theme.

At the end of a tick the loop re-arms rAF only if one of these holds: camera busy (inertia, eased zoom,
fly-to, live drag), decoded bitmaps waiting for upload, `lodDirty`, `dirty`, mount queue non-empty, a
screen layer animating. Otherwise it parks and starts a single `setTimeout(140 ms)` which runs the exact
cull + LOD pass ("settle"). Measured idle: 0 rAF callbacks, 0 % CPU in browser/renderer/GPU processes over 10 s.

`dirty` gates `app.render()`: ticks that only advanced a decode or a timer do not render.
`dt` is clamped to 50 ms and everything animated (inertia friction, zoom ease) is integrated against real
`dt`, so the feel is identical at 60 and 120 Hz.

### 2.3 Camera

State `{ tx, ty, scale }`, `scale` clamped to 0.05..4. World to screen: `screen = t + world * scale`.

| Behaviour | Value |
|---|---|
| Wheel (no modifier) | pan by `delta` (deltaMode normalised: line = 16 px, page = 800 px); OS supplies momentum |
| Ctrl/Cmd+wheel or pinch | `targetScale *= exp(-clamp(deltaY, ±20) * 0.012)`, eased toward target with `1 - exp(-18 * dt)`, anchored at the cursor via `zoomAt` |
| Drag release inertia | velocity from the trailing 80 ms of samples (only if release is < 60 ms after last sample); decay `0.935 ^ (dt / 16.7 ms)`; stops under 0.012 px/ms |
| Fly-to | 380 ms default, ease-out cubic, scale interpolated in log space, the world point at viewport centre interpolated linearly (pan and zoom stay coupled) |
| `version++` | on every change; the stage skips untouched frames by comparing against `renderedVersion` |

### 2.4 Culling with rbush

The store keeps an `rbush` (node size 16) of live elements' world AABBs (rotation and paint padding included;
children of frames are indexed in world coordinates and re-indexed when the parent moves). The stage never
iterates the whole board per frame.

- **Window:** viewport grown by `overscan = 0.5` of its size on each side (half a screen). Elements in the
  window get a pooled view; the ring exists so a pan finds sprites already mounted with a thumbnail.
- **Re-query triggers** (`cullAndLod`): the visible rect leaves the mounted window, OR the scale changed by
  more than 1.5x (either way) since the window was built, OR the loop settled. Otherwise the pass only runs
  the LOD logic.
- Hits are queued (not built immediately): cards first (their pictures take longest), then by distance from the
  view centre. `drainMounts()` builds views for ≤5 ms per tick, drops queued ids that left the window
  meanwhile. This took a zoom-out over 5,000 elements from 100-300 ms stalls to frame p99 33 ms.
- Unmount = `world.removeChild` + reset + return to a per-variant pool (`ViewPools`). Views are expensive
  (Pixi objects, text styles) and the viewport turns over hundreds per pan.
- `searchInto(box, out)` walks the tree manually into a caller-owned array (no per-query allocation) and
  bulk-collects fully-contained subtrees.
- Draw order lives in the store (frames in one sorted list, everything else in another, `(z key, id)`), ranks
  recomputed lazily when `orderVersion` changes; the stage just assigns `zIndex = rank`.
- Per-card on-screen flag (`onScreen` = touches viewport grown by 10 %) is distinct from "mounted": only
  on-screen cards may hold own textures or be pinned (3.7).

### 2.5 Store to stage contract

The stage consumes a structural interface (`StageStore`): `subscribe`, `get`, `elements`, `parentOf`,
`children`, `searchInto`, `rank`, `orderVersion`. It buffers `change` events into pending sets
(`added/removed/updated(props)/cards`) and applies them at the next tick (`flushStore`), so a burst of ops
costs one pass. A `source: 'load'` change means "rebuild everything" (snapshot/resync) and keeps resident
textures of cards that still exist. Elements are immutable, so `view.update(el, changedProps, rect, ctx)`
only touches what changed.

Interaction overrides never touch the store: `setPreview(id, rect)` (drag/resize/rotate), `setHidden`,
`setAlpha`, `pin` (keep mounted regardless of window), `setEditing`. A drag is previews only, committed as one
batch on release. A new rect object is passed per preview call (views compare against the previous one to
detect resizes; mutating in place once broke picture/caption re-splitting).

## 3. Texture pipeline

### 3.1 Levels

| Level | Source | GPU form | Chosen when card long side (device px) is | Notes |
|---|---|---|---|---|
| L0 | ThumbHash (about 25 bytes in the doc) | 32 px cell in a 1024 px page, no mips | < 24 | First paint, tiny cards, and the placeholder for everything mounted |
| L1 | 160 px WebP thumb | 128 px cell in 2048 px atlas page, 3 mips | 24 to 128 | Also the stopgap while L2 loads |
| L2 | 480 px WebP | Own texture, full mips, bucket 256 or 512 | 128 to 480 | Bucket 256 if `d <= 256 / 0.9`, else 512 |
| L3 | 1600 px WebP | Own texture, bucket 1024 or 1600 | > 480 | At most 12 cards at a time (the nearest to view centre); ~10 MB each |

"Device px" = `max(w, h) * scale * devicePixelRatio`. Originals never reach the canvas.

**Hysteresis** (`pickLevel`): a card moves up when `d > threshold[level] * 1.25` and down when
`d < threshold[level - 1] * 0.8`; inside the band it keeps its previous level. Without it a view parked on a
boundary flaps and re-fetches. The same band applies to caption visibility (7 device px of font).

`best(card, desired)` returns the resident texture for the desired level, else the nearest sharper one, else
the nearest blurrier one, so a sprite always shows the best thing it has; with nothing resident it paints a
flat themed placeholder (`Texture.WHITE` tinted).

### 3.2 What each level costs

- 1,000 cards of L1 = 5 pages x 22.4 MB (2048² x 4 B x 4/3) plus 2 L0 pages ≈ **115 MB**; 2,000 cards ≈ 204 MB.
  The ceiling of the design is atlas memory, not the renderer: at ~2,400 on-screen cards the pages alone fill a
  256 MB budget (pages are pinned while on screen). The original caps boards at 1,000 cards.
- L2/L3 are 0.3 to 10 MB each and exist only for on-screen cards that are big enough.
- A 1:1 pan at 2x DPR keeps ~25 L2 textures resident.

### 3.3 Atlas layout (`atlas.ts`)

A page is a square cut into strides of `cell + 2 * gutter`; each cell has a transparent gutter so bilinear
taps and the first mip levels cannot bleed between neighbours.

| Atlas | Page | Cell | Gutter | Stride | Cells/page | Mips |
|---|---|---|---|---|---|---|
| L0 | 1024 | 32 | 2 | 36 | 28 x 28 = 784 | none (`mipLevelCount: 1`) |
| L1 | 2048 | 128 | 4 | 136 | 15 x 15 = 225 | 3 levels (128 → 64 → 32 px cells stay clean), `mipmapFilter: linear` |

Cells are handed out in reading order; a freed cell goes back to its page's free list; a page with no used
cell is destroyed (so memory returns only when a whole page empties; the LRU accounts for this by treating
each cell as `pageBytes / cellsPerPage`). A cell's `Texture` is `new Texture({ source: page.source, frame: Rectangle(x, y, w, h) })`,
so every atlas card shares one `TextureSource` and the 7 pages of a 1,000-card board fit one batch
(Pixi batches up to 16 textures).

### 3.4 Decode workers and baked corners

`decode.worker.ts` does, off the main thread: `fetch(url)` (or decode a `Blob` the host already holds; the
original's CSP forbids `blob:` fetches so packs are handed over as Blobs under opaque names) →
`createImageBitmap` → `OffscreenCanvas(w, h)` at `min(1, maxLong / srcLong)` → `clip()` with `roundRect` → `drawImage`
(smoothing `high`) → optional 1 px hairline (`stroke()` of the clip path, `lineWidth 2` because the clip keeps
the inner half) → `transferToImageBitmap()` (zero-copy transfer). L0 decodes the ThumbHash to RGBA
(`thumbHashToRGBA`) and runs the same bake.

**Why bake instead of masking:** a rounded-corner `Mask`/`Graphics`/shader per card breaks batching (one
draw per card, stencil state changes). Baked, every card is a plain sprite in one batch, and the hairline
border is free. The radius is a constant in **world** px: the worker converts it to texels as
`radiusWorld * (texels long side / worldLong)`, clamped to half the short side, so corners look identical at
every level. Trade-off: theme/radius changes mean re-baking (the hairline colour is baked, so a theme change
that alters it drops all textures and reloads the viewport).

**Pool:** `clamp(floor(hardwareConcurrency / 4), 1, 4)` workers, 4 requests in flight per worker, least-loaded
dispatch. 4 workers did not help under CPU contention (decode time per item grows as cores saturate).
Decode costs 1 to 2.5 ms per thumb.

**Queue priority:** on-screen before off-screen (`dist >= 1e6` marks the ThumbHash prefetch for unmounted
cards), then lower level first (cheap → first paint), then nearest to the viewport centre. `setWanted()` is
called with the complete wanted set every LOD pass: new items queue, queued items no longer wanted are dropped,
in-flight ones get an `abort` message (the worker aborts the fetch). Failed requests are negative-cached for
30 s (an undecodable L3 must not loop).

**GPU-backed worker canvas, not `willReadFrequently`:** the CPU canvas looked safer (no GPU→GPU hand-off) but
made loads 2x slower in an A/B on the same machine (first paint 565 to 665 ms vs 1.3 to 1.4 s). The GPU canvas
costs a one-off "GPU stall due to ReadPixels" console notice. Keep a switch for software canvas if you target
odd GPUs.

### 3.5 Uploads under a time budget

`TextureManager.frame(budgetMs = 4, now)` runs once per tick before render. It drains decoded bitmaps until
4 ms is spent (at least one): measured max 0.7 ms per frame in the benchmark.

- **Own textures (L2/L3):** `new ImageSource({ resource: bitmap, alphaMode: 'premultiply-alpha-on-upload', autoGenerateMipmaps: true, scaleMode: 'linear' })`,
  then `renderer.texture.initSource(source)` immediately so the upload and mip chain happen inside the budgeted
  step, not at first draw. The bitmap is closed right after.
- **Atlas cells:** Pixi has **no partial texture upload**, so the manager binds the page through the renderer's
  texture system (`getGlSource`, `_activateLocation`, `_setBoundTexture`: private API, hence the pin), sets
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` (canvas-born bitmaps are already premultiplied; upload them as such: no conversion,
  no fringes) and calls `gl.texSubImage2D(target, 0, x, y, RGBA, UNSIGNED_BYTE, bitmap)`. It keeps Pixi's bound-texture
  and unpack-state caches coherent. Pages are created with `initSource` (storage allocated empty).
- **Mips:** pages are marked dirty per cell upload and `generateMipmap` runs **once per touched page per frame**.
- After uploads the stage re-points sprites of the changed cards (`applySlot → paintPost`).

### 3.6 Per-card slots and the LOD pass

Each post card has an integer **slot** (recycled through a free list) with typed-array state: wanted level
(`Int8Array`), on-screen flag, "owns a texture" flag. A `BoardCard` (key, w, h, thumbhash, urls, radius) is kept per slot
so ThumbHash can be requested for cards that have never been mounted.

`lodPass` per mounted card: pick level with hysteresis; compute on-screen (viewport + 10 %) and distance to view
centre; set flags; request L0 if missing; L1 if `lvl >= 1`, missing, and (on screen or the budget has
headroom); L2 only if on screen and `lvl == 2` (L3 cards keep L2 as stopgap until the 1600 px lands); then the 12
nearest L3 candidates are promoted, the rest fall back to L2. Cards in the mounted-but-off-screen ring get ThumbHash + L1 only
(keeps L2 at ~25 textures at 1:1 instead of ~60). Unmounted cards still get a far-priority ThumbHash prefetch.
If a card has no L1 URL yet, the stage asks the host once per key (`onNeedThumbs`, ≤256 keys) so thumbnails can
come as one pack request instead of 1,000 fetches.

### 3.7 Memory budget and LRU

Budget 256 MB (128 MB on ≤4 GB devices and iPad). `enforceBudget` runs after uploads and after every LOD
pass; when `pageBytes + ownBytes > budget`:

1. Own textures (L2/L3), least-recently-on-screen first, **skipping pinned ones**, until under `0.85 * budget`
   (`planEviction`, pure).
2. If still over 85 %: cold L1 cells (LRU by last on-screen), same rule.

**Pins follow the viewport, not the mounted set**, and an own texture is pinned only while its card is on screen
*and* still wants that level (`keep(slot, level)`). The first version pinned every mounted card: a zoom sweep reached
297 to 373 MB and sat over budget for 1.6 to 28 s; after the fix, peak 270 MB and over budget ≤84 ms.
`hasHeadroom()` (< 85 %) gates requests for off-screen L1 so the loop cannot fetch→evict→fetch forever.
After eviction the stage re-points affected sprites to a lower level before the next render (`takeEvicted`).

### 3.8 Texture retirement ("use after destroy")

Symptom: intermittent `Cannot read properties of null (reading 'addressModeU')` from the batch adaptor, healed
by rebuilding textures (seen in ~half of early full runs). Root cause found with a seeded fuzz (tiny budget,
random camera jumps, edits, undo, context loss): when a sprite swaps to a texture whose **source is already in
its batch** (an atlas page), Pixi's `Batcher.checkAndUpdateTexture` reuses the slot and never prunes the old
texture, so the batch keeps listing a texture no sprite uses. Destroying it later leaves a dead source in a
live batch and the next draw binds it.

Fix (`retire.ts`, ~65 lines):
1. **Nothing is destroyed inline.** Every teardown (`texture.destroy`, `atlas.release`) is pushed to a queue and
   runs only after **2 completed renders**, or after 1 when the loop parks (`flushIdle` in settle).
2. **Whenever something is parked, force a batch rebuild**: `world.renderGroup.structureDidChange = true`
   (the `onRetire` callback), so no batch can still name the old texture when the teardown runs.
3. Re-point sprites *before* the frame, destroy *after* it (context-loss teardown is deferred the same way).

A guard remains as a safety net: the whole tick is in try/catch; an exception drops every texture, rebuilds from the
viewport and logs the tick phase (`store/camera/upload/overlay/render`). The fuzz healed 6 frames in 25 s before the
fix and 0 after. Keep the fuzz test.

### 3.9 WebGL context loss

`webglcontextlost` → `preventDefault()`, set `lost` (no render, no upload). `webglcontextrestored` → `tm.reset()`:
cancel in-flight requests, clear queues, close pending bitmaps, create fresh atlases, park the old textures in the
retire queue, then re-run the LOD pass; the queue's priority (on-screen first) restores the viewport first. Measured:
restored and drained in 1.1 s, 0 failed decodes, texture bytes re-requested from the HTTP cache.

### 3.10 Load numbers

| Metric | Result (1,000 cards) | Budget |
|---|---|---|
| First paint (ThumbHash mosaic), cold / warm | 495 / 198 ms | 1.8 s / 1.0 s |
| All L1 loaded, local | 0.95 s | |
| All L1 loaded, simulated 50 Mbit/s (≥5 KB per thumb, one pack, no per-image latency) | 1.9 s | 2.5 s |

First paint and L1-complete are **worker-bound** (2,000 decodes). Batch the L0 requests and ship L1 as a single pack
request; per-image requests dominate otherwise.

## 4. Video

Pixi never decodes video. A video card is a normal image card whose thumbnail is the **poster**; on top of it
sits **one** DOM `<video>` (the overlay), shown only for the card that should play.

### 4.1 Geometry sync (`videoGeometry.ts`, `video.ts`)

- The `<video>` is laid out **once** at the card's world size (`width/height` in world px, `transform-origin: 0 0`,
  `position:absolute; left:0; top:0`) and positioned by `transform` only:
  `translate(x px, y px) scale(cameraScale) rotate(rot deg)`.
- A card rotates about the **centre of its box**; the top-left corner is rotated about that centre in world space to
  find where it lands, then the element rotates about that corner. Result: exact coverage of the sprite at any
  zoom/pan/rotation/DPR.
- Rounded corners: `clip-path: inset(0 round Rpx)` in the video's own (world) space, so the transform scales the corners.
- `object-fit: fill` (cards are aspect-locked and the thumbnail is stretched to the box, so they are one picture);
  `max-width: none; max-height: none` (a global `video { max-width: 100% }` once clamped zoomed-out cards).
  A card with a caption block under it: the video covers only the top `pictureH`.
- **Sync in the same rAF as the render** via a frame hook: `sync(camera)` writes only `transform` when the camera
  moved; `follow(rect, camera)` runs every frame with the card's *current* rect (live drag/resize/rotate preview,
  else the store's) because a card can move while it plays (drag, undo, a peer). Cached last-written strings avoid
  redundant style writes. Overlay root has `pointer-events: none`.
- Reveal: the `<video>` is transparent until a frame is paintable, then fades in over the thumbnail; stop fades back
  (150 ms) before releasing the network. A buffering ring appears after ~250 ms only if no frame is up.
  Returning to the same card during the fade carries on.

### 4.2 Play policy (`videoPolicy.ts`, `videoController.ts`: pure + injected timers)

| Rule | Value |
|---|---|
| Max overlays in hover/selection mode | 1 |
| Selection of exactly one playable video card | plays immediately |
| Hover | plays after **300 ms** (a pointer sweeping the board must not start a stream per card); ring starts counting at hover start |
| Minimum on-screen width | **160 CSS px** (below it a stream is not worth it) |
| Selection beats hover, but only if the selected card can play | |
| Blocked | while an edit tool/drag/carry is active (`enabled=false`), on touch (no hover, no selection playback), while the camera moves (hidden until settle), when the tab is hidden (suspend/resume) |
| Muted + `playsinline` + `loop` | required for autoplay on phones; if the browser refuses unmuted play, fall back to muted |

**"Always playing" mode** (a per-board setting): a small pool of the same overlay elements, one per card that touches
the viewport grown by 25 %, at any zoom, up to a safety ceiling of 96 streams (in-view cards beat margin cards; a
playing card keeps its seat unless another is 1.25x better). Starts are staggered (6 per pass, 50 ms apart) so 40
videos are up in under half a second; ≤16 idle elements kept; re-planned on settle and throttled to 150 ms while moving;
off with reduced-motion or data-saver.

**Lesson:** the pool's elements live inside **one world-space parent** that carries the camera transform. 40
individually transformed `<video>` layers stalled the compositor (30 fps, 60 to 130 ms long tasks while panning);
with one shared transform: ~120 fps, no long tasks, 90 videos included.

## 5. Background dot grid

A `TilingSprite` in **screen space** under the world (not inside the render group). The texture is a 64 px canvas
with a white 3 px-radius dot at the centre, tinted by the theme (`bg.tint`); opacity is a theme value
(about 0.08 dark / 0.10 light, deliberately subtle).

Per camera change (`applyCamera`):

```ts
const a = clamp((scale - 0.25) / 0.15, 0, 1);       // fades 25 % → 40 % zoom, hidden below 25 %
bg.visible = a > 0;
bg.alpha = a * theme.dotAlpha;                       // set here, once: an earlier bug overwrote it
bg.tileScale.set(scale * GRID / 64);                 // GRID = 24 world px between dots
bg.tilePosition.set(tx - (GRID/2)*scale, ty - (GRID/2)*scale);   // dot centred on the grid line
```

Cost is constant (one quad, any zoom, any pan). It is hidden below 25 % because dots 6 px apart become noise and
cost fill-rate. On resize set `bg.width/height` to the viewport.

## 6. Layout engine (`layout/`, pure, world space)

All functions take boxes/aspects and return rects or deltas; the caller turns them into store ops (one undo step).

### 6.1 Masonry (`masonry.ts`): the one primitive

Items go in order into the **shortest column** (leftmost on ties). Heights are `max(1, round(w * aspect))` so equal
columns tie exactly and layouts are reproducible across clients. `x = col * (slot + gap)`; `slot` = column width, widened
to the widest fixed-width item (notes keep their own width) so nothing spills into the next column. Bad aspects fall back
to 1.25. Returns rects relative to the block origin plus block `width/height` (gaps only between items).

### 6.2 Width, gap, columns (`placement.ts`)

| Quantity | Rule |
|---|---|
| Item width W | median width of cards already on the board if ≥3 cards, else default 248 |
| Gap G | `clamp(round(W / 10), 12, 48)` |
| Columns c (n items) | n=1 → 1; Shift/"single row" → n; else `clamp(round(sqrt(n * meanAspect)), 2, 10)` (roughly square block) |
| Anchor | 1 item: block top-left at pointer minus grab offset; n≥2: block centred on the pointer |
| Frame clamp | with the pointer in a frame, clamp the block inside the frame interior minus 24 px padding; if it does not fit, drop to canvas |

`planPlacement` is computed **once per carry** and only translated per pointer move
(`translatePlacementInPlace`, no allocation): 100 items under a millisecond.

### 6.3 Tidy into grid (`tidy.ts`)

1. Only cards, notes and shapes take part; arrows/lines/text/ink stay put.
2. Reading order via `bandOrder`: cluster by vertical centre (tolerance = half the median height, measured from the
   band's running mean centre), bands top to bottom, each sorted left to right. A row of cards with different
   heights stays one row.
3. W = median card width; notes/shapes keep their size. `c = clamp(round(sqrt(n * mean(h/w))), 1, 10)`.
4. Masonry anchored at the current top-left of what moves (or a frame's inner top-left). Result is overlap-free by construction.

### 6.4 Align / distribute / equal width (`align.ts`)

Work on world AABBs (rotation and paint padding included), return deltas; items already in place are omitted.

- `align(mode)`: left/centerX/right/top/middleY/bottom to the union box. **No-overlap rule:** with `opts.gap`, after
  lining up, `separate()` slides whatever would pile onto another box along the *other* axis, in the selection's
  prior reading order (a row aligned left becomes a column in the row's order; the first box of each pile stays put).
- `separate(items, gap, axis?)`: settle items one after another; one that collides (or is closer than `gap`) with the already
  settled moves past them to the right or down by whichever is shorter. Only right/down, so a cleared pair stays clear and
  the loop terminates in ≤ one pass per box.
- `distribute(axis)`: equal **gaps** (not equal centres), extremes stay, needs ≥3 items; the gap is never below the board
  gap (a span too short for the boxes pushes the last ones past the far extreme instead of overlapping more).
- `equalWidth`: every item takes the median width, aspect-locked items scale height, then `separate()` so a grown card pushes neighbours.
- The gap used is `arrangeGap(selected widths)` = `placementGap(median width)`, the same as grid and drawer placement.

Lesson: aligning is what makes a moodboard pile up; naive align/distribute put every card of a row on the same spot.

### 6.5 Auto spot for inserts (`autoSpot.ts`)

Where a block goes when nobody places it by hand: nearest free spot to the viewport centre. Instead of testing every
lattice candidate against every box, each occupied box paints a rectangle of blocked lattice cells into a 2D
**difference array** (a block's top-left overlaps box B exactly when it lies in `(B.min - blockSize, B.max)`);
one prefix-sum pass then answers "is this cell free" in O(1). Cost O(boxes + cells), independent of block size.

| Parameter | Value |
|---|---|
| Lattice step | 48 world px |
| Search window | rings of the lattice; starts at 8 rings, doubles up to the bound |
| Max radius | 2 x viewport diagonal; hard cap 160 rings (103k cells), past which the step grows |
| Order | ring by ring outward; within a ring the nearest to centre wins, ties go to reading order |
| Touching boxes | stay free (epsilon tolerance) |
| Fallback | viewport centre |

`shouldPanTo(block, viewport)` is true when more than half the block is off screen (the camera then flies there).

### 6.6 Hit testing (`hitTest.ts`)

Two phases: `searchInto` with a tiny box around the point grown by the screen tolerance (4 px / zoom), then an exact
per-kind test (rotated rect, signed distance to rounded box/ellipse, distance to polyline for ink) on the few
candidates (the topmost by draw order wins). All thresholds are screen px divided by the zoom.

## 7. Snapping and smart guides

### 7.1 Snap model (`interact/snapping.ts`, pure)

While a box is moved or resized it snaps X and Y independently to four families: **alignment** (its left/centre/right and
top/middle/bottom lines vs the same lines of nearby elements and frames' inner edges), **equal gaps** (the gap to the
nearest neighbour on its row/column becomes equal to a gap already present, or it centres between its two neighbours),
and **size match** (resize of one edge takes the width/height of a nearby element on its row/column).

| Parameter | Value |
|---|---|
| Threshold | **6 screen px** (divided by zoom to get world units, so it feels the same at every zoom) |
| Priority | smallest `|delta|` wins; on ties alignment > size match > gap |
| Hysteresis | a held target releases beyond **1.5x** the threshold; another target steals it only if nearer by more than **0.5x** the threshold; a reused result object remembers each axis' winner; Cmd/Ctrl suspends snapping and resets it |
| Coincident lines | within 0.01 world units counted as one guide |
| Frame inner edge | 24 world px inside the frame box |
| Candidates | built **once per drag**: elements meeting the viewport grown by 25 %, nearest **400** |
| Gap collection | among the first 400 candidates; a box looks ≤64 blockers deep |
| Reference guides drawn | the 3 nearest matching gaps, ≤3 size matches, ≤6 aligned boxes per line |
| Cost | `SnapIndex` = sorted line arrays per axis (typed arrays), gaps sorted by size, sorted widths/heights; a move is a few binary searches plus one linear neighbour pass. Measured p95 **0.1 ms**, max 0.2 ms per move (budget 0.3) |

Output: `{ dx, dy, guides[] }` where `dx/dy` is the correction to add; a box already on a line reports 0 and still carries the guide.

### 7.2 Guide rendering (`render/guides.ts`)

Drawn in **screen space** by the overlay (not in the world container), so line weight is independent of zoom.

- **Hairlines are exactly one device pixel**: filled `rect`s (not strokes) on the device pixel grid:
  `cell(v) = floor(v * dpr + 1e-6) / dpr` for the line position, `round(v * dpr) / dpr` for the ends, width/height `1/dpr`.
  Crisp at any zoom and pixel ratio; strokes were 2 device px on retina and blurry.
- Frame inner-edge guides are dashed (4 on / 3 off).
- "×" marks (3 px arms, pixel-exact) at every aligned corner/centre; a guide spans first mark to last plus a 3 px overshoot; the centre guide is dropped when the two edge guides already show it.
- **Spacing/size measures:** the segment with end caps (3.5 px half-length) and a compact label **pill**
  (16 px high, 5 px side padding, radius 4, 11 px semibold UI font, "=" for a width/height match, rounded integer for gaps).
  Pill centred on the segment if the segment is long enough to hold it with caps showing, otherwise beside it (4 px away);
  overlapping pills are dropped; pills and their `Text` objects are pooled.
- A dedicated guide hue per theme (rose on dark, magenta on light), apart from the selection accent.
- Guides are keyed by what they *show* (line by axis+kind+position; measure by segment) and fade in/out over **80 ms**,
  so a guide that persists while the pointer moves within the threshold never blinks. The layer redraws only when its
  guides, the camera or a fade changed. Guides are local only (never sent to collaborators).

## 8. Captions under cards

A card shows its post's text under the picture: 2 rows with ellipsis, click to expand, per-card flag to hide.

**The synced box is the layout box.** With a caption on: `h = w * aspect + block`; `block` is whatever the box has left under
the picture. Selection, hit testing, snapping, tidy and resize therefore need no caption awareness. Rules that make it work:

- Block height is **proportional to width**: font 13 px, line height 1.35, paddings (2, 8, 6) all scale by `w / 248`, so
  aspect-locked resize, "equal width" and tidy preserve the proportions and a text wraps identically at any width.
- Block height is **deterministic**: rows = 0 (no text), 1 if `normalized length <= floor((248 - 4) / (13 * 0.56))`, else 2. A character-count
  estimate, never font metrics, so **every client writes the same number** and the shared box never depends on whose fonts measured it.
  (Estimate em width 0.56 is slightly wider than a system sans so a one-row estimate never needs two.)
- What is *drawn* is measured: rows are broken **once per text at the reference width** (canvas `measureText`, cached, ≤4000 entries) and cut to the
  rows the box really has; never per frame, never per resize preview.
- A box with no room (cards created before the feature) shows no caption and reads as "off"; switching it on grows the box
  (`captionPatch`: writes the flag and the new height in one undo step; rotated cards move their origin so the picture stays still).
- `postSplit(box, aspect, wanted, text)` returns `{ mediaH, captionH, rows }`; `rows = floor((room - padTop - padBottom) / lineHeight + 0.1)`
  (0.1 absorbs the masonry's integer rounding).
- **Zoom LOD:** the caption `TextBlock` exists only while on screen and readable (`captionVisible`: ≥7 device px of font, with the 0.8 hysteresis).
  Under that nothing is drawn (the gap remains), so a 1,000-card view holds no caption texts.
- Expanding is a viewer-local overlay (full text in a panel above every card), never written to the box; it closes on
  second click, Esc, press elsewhere, or when the card changes/moves/leaves the screen.
- The pure `captionLayout(text, width, style, measure?)` is shared with the export.

## 9. Performance budget and harness

### 9.1 Budgets and results

| Metric | Budget | Result |
|---|---|---|
| Frame interval p95 / p99, pan/zoom, 1,000 cards | 16.7 / 25 ms | 8.7 to 9.3 / ≤9.3 ms (120 Hz vsync = 8.3 ms) |
| Work per frame with a 1.5x safety margin | tick CPU p95 ≤11.1 ms; GPU p95 ≤5.3 ms | tick p95 ≤1.5 ms; GPU p95 ≤3.3 ms (worst: zoom sweep) |
| React commits while interacting | 0 | 0 (control: a deliberate React toggle registers 1) |
| GPU texture bytes | ≤256 MB, never >1 s over | peak 270 MB before the frame's eviction pass, over for ≤84 ms |
| JS heap after 10 pan cycles | ≤200 MB, ±5 % | 7.8 MB, flat |
| Idle | 0 rAF, 0 % CPU | 0, 0 % (10 s) |
| Upload per frame | ≤4 ms | max 0.7 ms |
| 4x CPU throttle | frame budgets hold | frame p95 ≤10.0 ms, tick p95 ≤5.1 ms |
| 2,000 cards | | frame p95 8.7 to 9.3 ms, tick p95 ≤1.5 ms |
| "Board at caps" (1,000 cards + 4,000 other elements) pan | | tick p95 2.1 to 2.8 ms |
| Drag 50 selected with snapping | | frame p95 9.3 ms, tick p95 0.8 ms |
| Carry 100 ghost cards over 300 cards | | tick p95 0.5 ms |
| Drop 100 cards: optimistic visible / acked | | 17 ms / 48 ms |

Why it is this fast: a pan at zoom-to-fit costs 0.1 to 0.5 ms CPU and ~0.4 ms GPU per frame because the camera is a render-group
transform (instruction set not rebuilt) and the atlas pages fit one batch. The expensive frames are those that **change the scene**
(zoom sweeps: re-cull + LOD every 100 ms, uploads, L2 churn): 1.2 to 1.8 ms p95 for 1,000 cards. The one measured weak spot is a zoom
sweep over the board at caps with thousands of non-card elements (tick p95 ~20 ms): mounting vector/text elements is the cost, hence the
mount budget and greeking.

Other CPU-side rules the budgets rely on: text is *greeked* (grey bars) under 4 device px and re-rasterised at exactly `zoom x dpr` on settle (budget 12 re-rasters per tick);
ink strokes use 3 cached outline LODs and cached `Graphics` contexts (≤120 new geometries per tick); per-view LOD hooks are a multiply and two compares.

### 9.2 React must never re-render during interaction

The canvas is plain TypeScript; React hosts it and reads a **coarse** store (selection ids, counts, `canUndo`) via `useSyncExternalStore`.
`camera` events fire every frame and are for imperative updates (zoom label via DOM ref); `cameraSettled` fires 140 ms after the camera stops
and is the only safe moment for React state. Floating UI hides during drags/resizes (an `interaction` event). The benchmark counts React commits
with a commit-counter probe and fails on >0, with a control that proves the probe works.

### 9.3 Benchmark harness

Playwright + real input over CDP (`Input.dispatchMouseEvent` wheel with ctrl for pinch, press/move/release for drags, key events), plus
probes: rAF intervals, long tasks/LoAF, React commit counter, and the stage's own counters (`tick` and `render` CPU ms, per-render GPU time via
`EXT_disjoint_timer_query_webgl2`, uploads, texture bytes, JS heap, process CPU for idle).

Scenarios: wheel pan and drag+inertia at fit and 1:1; 5 % → 400 % → 5 % pinch sweep; fit/100 % flights; the same pan/zoom **scripted inside the loop**
(`stage.drive('pan'|'zoom')`, no CDP round trip: the load-robust twin); 10 pan cycles (heap, texture, GPU process memory); 10 s idle; context loss;
a React-toggle control; a 2,000-card pass; cold/warm/throttled-network loads; plus a seeded **texture-lifetime fuzz** (tiny budget, random camera jumps, edits, undo/redo, context loss; asserts no page error, zero healed frames, retire queue drains).
Also a 4x CPU throttle pass (CDP CPU throttling). A committed baseline JSON gates regressions (>15 % worse p95; tick p95 always; frame p95 only if the control page shows a quiet host).

Margin rule: a rAF interval cannot go below vsync, so the safety margin is applied to the **work** of a frame, and the interval must show no missed frame
(at 60 Hz the gate is 17.5 ms: 5 % vsync jitter).

### 9.4 Harness traps

1. **Headless Chromium silently falls back to SwiftShader** (software GL) if its GPU process fails to start: the first full runs measured the CPU rasteriser (rAF p95 25 to 170 ms,
   "GPU time" 60 ms). Pass `--use-angle=metal` (or the platform equivalent), `--enable-webgl-developer-extensions`, `--ignore-gpu-blocklist`, and **assert the unmasked renderer string does not match `/swiftshader|llvmpipe|software/i`**.
2. **Shared machine noise.** Measure a control page (blank WebGL + rAF loop) before and after; a control p95 >17.5 ms flags "host contended". Frame pacing survived load average 10 to 40
   once the GPU was real; load-time numbers (decode, first paint) did not.
3. `cpuMsPerTick` from outside includes the browser's per-frame cost (~0.4 ms for a blank WebGL page) and the CDP round trip; use the stage's own `tick` column for the board's cost.
4. CPU-throttled idle shows high renderer CPU with 0 rAF callbacks: that is the throttle emulation, not the board.
5. Display refresh matters: on a 120 Hz screen a 16.7 ms budget is a 2x margin; re-run on a 60 Hz and a weaker GPU (iGPU) machine before trusting GPU numbers.
6. Measure scroll/pan with **real input events**, not synthetic `scrollTo`.

## 10. Gotchas and lessons learned

1. **Pixi system ticker keeps a rAF alive** through its GC scheduler; stop it before `init` and disable `gcActive`, or idle is never 0 %.
2. **Pixi GC would unload atlas pages** (no resource to re-upload from) after 60 s unused; turn it off and own lifetimes.
3. **Pixi has no partial texture upload**: atlas cells need `texSubImage2D` through private state; pin the version, isolate the code in one file.
4. **Destroying a texture a stale batch still lists crashes a later frame** (section 3.8): defer teardown by 2 renders and force `structureDidChange`.
5. **Pins must follow the viewport**, not the mounted set; and only while the card still wants that level.
6. **Re-point sprites before the frame, destroy textures after it.** Evicted cards must fall back to a lower level immediately.
7. **Bake corners in a GPU-backed worker canvas**; a software canvas halves load speed.
8. **Premultiplied alpha:** upload canvas-born bitmaps premultiplied (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`), otherwise dark fringes at rounded corners.
9. **Atlas gutters + limited mips (3 levels):** bleeding between neighbours shows as faint edges on tiny cards.
10. **Keep a view's change-detection honest:** mutating a rect in place made a card never notice it was resized (picture stretched during a resize); pass a fresh object.
11. **Wake the loop on any overlay state change.** A selection box was not drawn until the next unrelated wake because the loop was parked; make the overlay call `wake` itself instead of trusting every caller.
12. **Pixi `Text` resolution changes only re-validate on render:** a settled LOD pass that changed text resolution must mark the stage dirty (`ctx.invalidate()`), or text stays blurry after a zoom.
13. **Text crispness:** rasterise at exactly `zoom x dpr` on settle (not the nearest power of two) and draw on whole device pixels (`roundPixels`); edge sharpness at 1.37x/2.3x went from 0.70/0.63 to 0.95.
14. **Time-budget everything that scales with the board:** view mounting (5 ms), texture upload (4 ms), text rasters, ink geometry builds; defer the rest to the next tick and keep the loop alive.
15. **Don't spawn a `<video>` per card or per-video transforms.** One overlay (or one world-space layer for many) with a single camera transform.
16. **The browser's `video { max-width: 100% }` base style** silently clamps zoomed-out cards; opt the overlay out.
17. **Compositor pitfalls:** per-card `backdrop-filter` or hundreds of transformed DOM layers kill pan fps; keep the DOM overlay set tiny.
18. **Rounded-corner anti-aliasing on composited video layers** shows a light seam at the card edge; use an opaque mask layer rather than overscan if you see it.
19. **Hairlines:** draw on the device pixel grid with filled rects; strokes at 1 CSS px are 2 device px on retina and blur at fractional zoom.
20. **Hysteresis everywhere a threshold meets a continuous input** (LOD levels, caption visibility, snap hold/release, hover delay); otherwise parking on a boundary flaps and re-fetches.
21. **Never put non-deterministic measurement into synced geometry** (captions): use a character-count estimate for the shared number, real metrics only for drawing.
22. **Arrange operations must be overlap-safe** (align/distribute/equal width): lining up edges alone piles cards on one spot.
23. **Resizing clears the canvas drawing buffer:** render synchronously in the resize observer or an animated resize (sidebar folding) flashes blank frames.
24. **Context loss and mid-frame exceptions share one recovery path** (drop all textures, rebuild from the viewport); test both with the fuzz.
25. **Don't gate correctness on one machine.** All numbers above are one 120 Hz Apple-silicon laptop; GPU cost on iGPUs/Safari/iPad is the least certain part.

## 11. How to reuse

### 11.1 Minimal module set

Copy these (they are framework-free TypeScript; only Pixi, `rbush` and `thumbhash` as dependencies):

| Group | Files | Notes |
|---|---|---|
| Core renderer | `stage.ts`, `camera.ts`, `textures.ts`, `atlas.ts`, `lod.ts`, `lru.ts`, `retire.ts`, `decode.worker.ts`, `decode.protocol.ts`, `cards.ts`, `types.ts` | The heart. `stage.ts` is large because it also hosts text/ink/shape/frame mounting; for a cards-only board you can delete `otherViews`, the raster/build budgets and the caption panel |
| Views | `views/view.ts` (contract), `views/pool.ts`, `views/postView.ts` | Add other kinds later through the same `ElementView` contract |
| Store index | the rbush + draw-order parts of `store/doc.ts` (`searchInto`, `rank`, `orderVersion`, reindex on change) | or any store that satisfies `StageStore` |
| Math | `interact/geometry.ts`, canvas math (`zoomAt`, `visibleWorldRect`, `wheelZoomFactor`) | tiny |
| Layout | `layout/masonry.ts`, `placement.ts`, `tidy.ts`, `order.ts`, `align.ts`, `autoSpot.ts`, `stats.ts` | zero dependencies besides geometry |
| Snapping | `interact/snapping.ts`, `render/guides.ts` (+ `overlay.ts` hosting) | guides need a screen-space container above the world |
| Video | `overlay/videoGeometry.ts`, `videoPolicy.ts`, `videoController.ts`, `video.ts` (+ `ambient*.ts` if you want always-playing) | `video.ts` uses an app-specific reveal helper; replace with ~40 lines of fade/ring |
| Captions | `store/caption.ts`, `render/views/captionText.ts` | optional |
| Tests/harness | unit tests for `lod`, `atlas`, `lru`, `camera`; perf harness + fuzz | copy the harness *ideas* (section 9), not the page |

### 11.2 Interfaces between modules

```ts
// What the stage reads from your store (structural; any store works)
interface StageStore {
  subscribe(l: (e: StoreEvent) => void): () => void;   // emits { type:'change', change: ChangeSet } (added/removed/updated{el,props}/source)
  get(id): Element | undefined;  elements(): IterableIterator<Element>;
  parentOf(id): Element | undefined;  children(frameId): readonly ElementId[];
  searchInto(box: Box, out: Element[]): Element[];     // rbush window query
  rank(id): number;  readonly orderVersion: number;    // draw order
}

// What the stage needs per image card (CardRegistry: key → media)
interface CardMedia { key; available; aspect?; thumbhash?: Uint8Array; l1Url?; l2Url?; l3Url?; caption?; videoUrl? }
registry.onNeedThumbs = (keys) => /* fetch pack */ registry.patchMany([{ key, fields: { l1Url } }]);

// The contract of a per-kind display object
interface ElementView {
  variant; display: Container; mount(el, rect, ctx); update(el, props, rect, ctx); setRect(rect);
  refresh(ctx); lod(ctx, settled); unmount(); setAlphaOverride(a); setEditing(b);
}

// Stage extension points
stage.attach(store);  stage.onFrame(camChanged => syncDomOverlays);  stage.onSettle(() => reactSafeState);
stage.addScreenLayer(container, { draw(cam, w, h, now, dt): boolean, animating }, 'under' | 'over');
stage.setPreview(id, x, y, w, h, rot);  stage.pin(id, true);  stage.cam.{wheel,dragStart,dragMove,dragEnd,pinch,flyTo,jumpTo}
// TextureManager ↔ stage
tm.setWanted(items); tm.frame(budgetMs, now): number[]; tm.best(card, level); tm.takeEvicted();
tm.afterRender(); tm.flushRetired(); tm.keep = (slot, level) => boolean; tm.reset();
```

### 11.3 What to replace

| Original piece | Replace with |
|---|---|
| Store (optimistic, server-authoritative, conditional undo, pending-op masking) | Your own store, as long as it exposes `StageStore`, immutable elements and an rbush. A local-only app can use a 200-line map + rbush + undo stack |
| Sync/transport/presence | Not part of the renderer. The stage only needs `subscribe` events |
| Thumbnail source (server renditions: ThumbHash in doc, 160/480/1600 px WebP, packed L1 request) | Anything that can give a tiny placeholder + 3 sizes. If you only have originals, generate the ladder on upload; do not skip L1 (the atlas is what makes 1,000 cards cheap) |
| Fonts, theme tokens, i18n labels | Your design system; keep `Theme` as a plain object with `canvas, well, dot, dotAlpha, border, borderAlpha, guide` and re-bake on hairline changes |
| Video reveal helper (`lib/videoReveal`) | A fade + optional ring; the geometry/policy modules are independent of it |
| Host/engine façade (tools, commands, clipboard, ghosts) | Yours. The reusable seams are `ghosts` (translate a cached `planPlacement`), `buildSnapIndex` (once per drag), and `autoSpot` |

### 11.4 Suggested port order

1. `camera.ts` + `stage.ts` skeleton with colored rects, on-demand loop, bg grid, rbush culling and view pools. Verify idle = 0 rAF.
2. Add `TextureManager` with L0 + L1 only (atlas + workers + baked corners). Verify 1,000 cards pan at vsync.
3. Add L2/L3, LRU with viewport pins, `retire.ts` (with the fuzz test from day one).
4. Add layout + snapping + guides on top of previews (`setPreview`).
5. Add video overlays and captions last; they need nothing from the texture pipeline except the poster.
6. Stand up the harness early (SwiftShader assertion, control page, React-commit probe) and commit a baseline.

### 11.5 Known limits and open items

- Atlas memory is the scaling limit (~115 MB per 1,000 cards; ~2,400 on-screen cards fill 256 MB). Beyond ~2,000 cards: smaller cells (96 px), L1 only for on-screen cards, or an instanced card mesh (not needed so far).
- Measured on one 120 Hz Apple-silicon laptop; no Windows/iGPU/Safari/iPad numbers.
- Private Pixi API dependency (partial uploads, batch invalidation): a Pixi upgrade needs a re-check and a fuzz run.
- Zoom sweeps over thousands of non-card elements are the slowest scenario (tick p95 ~20 ms); mount budgeting and greeking mitigate but do not remove it.
