# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.1.0]

First release, published as `@niccolofanton/corkboard`.

### Added

- Infinite WebGL canvas of image, video and embed cards on Pixi v8 (`pixi.js` ^8.22.0 as a peer dependency), with pan, zoom and an on-demand render loop (no `requestAnimationFrame` callbacks while nothing moves).
- Viewport culling through an rbush index, so cards outside the view cost nothing.
- Level-of-detail image pipeline: ThumbHash placeholder, shared atlas, per-card textures with baked rounded corners, decoded in a worker pool under an LRU memory budget.
- Video cards: a WebGL poster plus a `<video>` element synced to the camera, with a play pool (`always` / `hover` / `off`) that adapts to the frame rate.
- Embed cards for YouTube, Vimeo, Spotify, CodePen, Figma, any page or a snippet of HTML: a poster sprite that becomes a sandboxed iframe at a virtual 720p / 1080p screen, with live / parked / culled lifecycle, runtime posters and snapshots.
- Auto layout (masonry, tidy grid, align, distribute, equal width) with animated transitions.
- Interaction: selection and marquee, drag, resize and rotate, smart-guide and dot-grid snapping, keyboard shortcuts, hand tool.
- Typed events (`selection`, `hover`, `click`, `dblclick`, `transform`, `gesture`, `delete`, `change`, `camera`, `cameraSettled`, `embedInteract`, `embedLive`, `embedResolved`) and a `stats()` API.
- Extension points: custom element kinds (views and DOM overlays), light / dark theme, optional CSP-safe mode.
- Single bundled `dist/index.d.ts` that resolves under `node16`, `nodenext` and `bundler` module resolution.
- Decode worker inlined as a blob worker; also exported as `@niccolofanton/corkboard/decode.worker.js` for pages whose CSP forbids blob workers (`textures.workerUrl`).
