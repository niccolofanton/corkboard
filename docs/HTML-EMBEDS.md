# HTML content cards (embeds and snippets) on a WebGL infinite canvas

Research date: 2026-10-12. Context: PixiJS v8 canvas, 1000+ media cards, culling + LOD textures, existing camera-synced DOM layer used for live `<video>`.

## TL;DR

- **Hybrid LOD is confirmed.** Poster texture in WebGL by default; one live sandboxed `<iframe>` in the camera-synced DOM layer only for the few cards that are large enough and focused.
- **HTML-in-Canvas does not replace the iframe path.** It cannot paint cross-origin iframe content (by design), it is Chromium-only, and it is still an origin trial. At most it is a progressive enhancement for same-origin, non-iframe snippets.
- **Posters come from the network, not the browser.** oEmbed `thumbnail_url`, then `og:image`, then a server-side screenshot. In-browser rasterizers cannot see cross-origin iframes.
- **Snippets run in `sandbox="allow-scripts"` `srcdoc` iframes** (opaque origin). A tiny injected script can snapshot its own DOM and `postMessage` a poster out.

## 1. Technique comparison

| Technique | Fidelity | Interactive | Cross-origin | Perf @1000 cards | Browser support | Complexity |
|---|---|---|---|---|---|---|
| **A. DOM iframe overlay** (CSS `matrix()` layer synced to camera) | Perfect (real browser) | Yes (full) | Yes, except sites sending `X-Frame-Options`/`frame-ancestors` | Only OK if live count is capped (each cross-site iframe is a process under Site Isolation) | All | Medium (lifecycle, z-order, input) |
| **B. Poster texture in WebGL** (oEmbed/og:image/screenshot) | Static image | No | n/a (fetched server-side) | Excellent (same as image cards) | All | Low-medium (poster pipeline) |
| **C. HTML-in-Canvas** (`drawElementImage` / `texElementSubImage2D`) | Native renderer | Yes (DOM stays real, hit-testing synced) | **No: cross-origin iframe content is not painted** | Good for few elements; main-thread bound | Chromium only, origin trial | Medium-high |
| **D. SVG `foreignObject` snapshot** (modern-screenshot, html-to-image, html2canvas) | Approximate (fonts/images must be inlined, bugs in Safari) | No | Same-origin only; **iframes not captured** | Slow per capture (tens to hundreds of ms, main thread); fine as one-shot | All (with quirks) | Medium |
| **E. Server-side screenshot** (headless Chromium, e.g. Cloudflare Browser Rendering `/screenshot`) | High, runs JS | No | Yes, but bot-blocked/consent-walled pages fail | Excellent (cached image) | n/a | Medium (infra, cost, SSRF) |
| **F. Sandboxed `srcdoc` iframe** (user snippets) | Perfect | Yes | Opaque origin, isolated | Same as A | All | Low |

Verdict: **A + B (+ E for posters) is the baseline. F covers snippets. C and D are optional enhancements for snippets only.**

## 2. How existing canvas apps do it (what is documented)

| App | Evidence |
|---|---|
| **tldraw** | Embed shape = iframe in the HTML layer. Single click selects; **double-click/Enter enters edit mode where pointer events reach the iframe**; Esc/click-outside exits. Per-provider sandbox, allowlisted hostnames; unrecognized URLs become **bookmarks**. YouTube/Vimeo lock aspect ratio; Vimeo corrects to real aspect after creation. Pasted raw iframe code gets a stricter sandbox (no same-origin). ([embed shape](https://tldraw.dev/sdk-features/embed-shape), [persistent iframe](https://tldraw.dev/examples/persistent-iframe-shape)) |
| **Excalidraw** | Read from source ([App.tsx](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/App.tsx)): wrapper uses `translate(...) scale(zoom)`; **mounts an iframe only when in viewport, then keeps it mounted and hides with `display:none`** (`initializedEmbeds`); `pointer-events` is `none` until state `active` (hover shows an "interact" hint, click activates); `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads"` plus `allow-same-origin` only for allowlisted providers; `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"`; no `loading` attr; video embeds are counter-scaled (clamped 0.75..4) to stay sharp. CVE-2024-32472 was a stored XSS from `allow-same-origin` ([advisory](https://security-tracker.debian.org/tracker/CVE-2024-32472)). |
| **FigJam** | Embed node has `srcUrl` "loaded in an iFrame **when the embed is activated**", plus `canonicalUrl`, `title`, `provider` ([EmbedData](https://developers.figma.com/docs/plugins/api/EmbedData)). Inactive state = static card. |
| **Miro** | Community thread shows a generic thumbnail + play overlay for iframe embeds ([thread](https://community.miro.com/ideas/better-handling-of-iframe-embedding-16332)). Loading internals not documented. |
| Milanote, Muse, Kosmik, Are.na, Heptabase | **No public documentation found** for their embed loading strategy. Do not assume; the pattern above (placeholder until activated) is the only evidenced one. |

Common pattern: inert placeholder by default, interaction is an explicit mode, allowlist of providers, bookmark fallback.

## 3. HTML-in-Canvas (WICG) status, October 2026

- **What it is:** `<canvas>` children are laid out but not painted; `paint` event + `requestPaint()`; `drawElementImage()` (2D), WebGL and WebGPU texture upload variants. Explainer: [WICG/html-in-canvas](https://github.com/WICG/html-in-canvas), spec draft: [wicg.github.io/html-in-canvas](https://wicg.github.io/html-in-canvas/).
- **Chrome:** DevTrial in Chrome 138; **origin trial started 148** ([Intent to Experiment](https://groups.google.com/a/chromium.org/g/blink-dev/c/t_nGEmJ_v4s), [OT announcement](https://developer.chrome.com/blog/html-in-canvas-origin-trial)); **now extended through Chrome 160 and not shipped to stable** ([OT changes](https://developer.chrome.com/blog/html-in-canvas-ot-changes)). Local testing: `chrome://flags/#canvas-draw-element`.
- **API is still moving.** Chrome 155+ renames: `layoutsubtree` -> `content="drawable"` (+ `drawable` attr on descendants); WebGL `texElementImage2D` -> **`texElementSubImage2D`** (no storage allocation, pre-allocate with `texImage2D`); WebGPU `copyElementImageToTexture` -> `drawElementImageToTexture`; `drawElementImage()` returns `void`; for WebGL you call `canvas.updateElementGeometry(el, { canvasTransform })` yourself. Blog posts written before this still show the old names.
- **Other engines:** Gecko "No Signal" (earlier text said Negative; Gecko flags synchronous-paint implementation challenges), WebKit "No Signal" ([mozilla/standards-positions#1076](https://github.com/mozilla/standards-positions/issues/1076), [WebKit#630](https://github.com/WebKit/standards-positions/issues/630)). No implementation outside Chromium.
- **Cross-origin iframes: refuted as a use case.** Privacy model is "read-back-allowed rendering": cross-origin content in iframes, images, `url()` refs, cross-origin SVG, and tainted canvases is **not painted**; same-origin iframes paint, but cross-origin content inside them does not ([explainer, Privacy and Security](https://github.com/WICG/html-in-canvas)). Chrome says the same: "does not work with cross-origin iframe content" ([OT post](https://developer.chrome.com/blog/html-in-canvas-origin-trial)). Also: a `sandbox` iframe without `allow-same-origin` has an opaque origin, so I expect it is treated as cross-origin and not painted (inference, not tested).
- **Other constraints:** only direct canvas children are drawable; Pixi's canvas would have to host the HTML children; the paint model is main-thread; video is not mentioned as supported.
- **Where it could help:** same-origin, script-free, sanitized user HTML (rendered as a real DOM child, no iframe) drawn into a Pixi texture, giving WebGL-composited z-order and effects. Feature-detect `'texElementSubImage2D' in WebGL2RenderingContext.prototype`, keep the sanitized-DOM snapshot (D) or sandboxed iframe (F) as fallback. **Not worth building before it ships to stable.**

## 4. Poster pipeline (the low-LOD texture)

Order of preference, first hit wins; always cache the result to **our own storage** and serve it same-origin or with CORS.

1. **oEmbed `thumbnail_url`** (+ width/height; all-or-nothing per [spec](https://oembed.com/)). Cheap, official, correct aspect hints.
2. **OpenGraph `og:image`** fetched server-side (CORS blocks the browser from reading arbitrary pages).
3. **Server-side screenshot** of the URL (or of the `html` for snippets). Cloudflare Browser Rendering `/screenshot` accepts `url` or `html`, `viewport`, `deviceScaleFactor`, `selector`, `gotoOptions.waitUntil`, `addStyleTag` ([docs](https://developers.cloudflare.com/browser-rendering/rest-api/screenshot-endpoint/)). Always identified as bot traffic (no bypass). Free plan: 10 min browser time/day, 6 REST requests/min; paid: 600/min, $0.09 per extra hour ([limits](https://developers.cloudflare.com/browser-rendering/limits/), [pricing](https://developers.cloudflare.com/changelog/post/2025-07-28-br-pricing/)). Queue it, never block insert on it.
4. **Generated tile** drawn in Pixi (favicon + title + host) if everything fails.

Gotchas:
- A third-party image in a WebGL texture needs CORS (`crossorigin="anonymous"` + `Access-Control-Allow-Origin`), otherwise upload fails/taints. This is why posters must be re-hosted, not hot-linked (`i.ytimg.com` etc. also may change URLs).
- Server fetching user URLs is an **SSRF** vector: block private/loopback/link-local IPs, cap size/time, follow redirects manually.
- Treat poster as a normal media asset: generate the same LOD ladder/mips as image cards.

## 5. Provider matrix (oEmbed / embed URLs)

Checked live with `curl` on 2026-10-12 unless noted.

| Provider | oEmbed | Iframe in response | Poster | Notes |
|---|---|---|---|---|
| YouTube | `youtube.com/oembed?format=json&url=` OK, no auth | Yes (`/embed/ID`, with `allow=` list) | `thumbnail_url` (480x360 hqdefault) | `width/height` are tiny defaults (200x113); aspect is 16:9, ignore returned size |
| Vimeo | `vimeo.com/api/oembed.json?url=` (public per docs) | Yes (`player.vimeo.com`) | `thumbnail_url` | My two sample IDs returned 404 from curl: verify before relying. Real aspect differs per video (tldraw re-sizes after create) |
| Spotify | `open.spotify.com/oembed?url=` OK, no auth | Yes (`iframe_url`, `loading="lazy"`) | `thumbnail_url` | Fixed heights (152/352) |
| X / Twitter | `publish.twitter.com/oembed?url=` OK | **No: `<blockquote>` + `widgets.js`**, `height: null` | none | `x.com` itself sends `X-Frame-Options: SAMEORIGIN`. Needs script injection (put in sandboxed srcdoc) or a screenshot-only card. Needs testing |
| Instagram / Meta | Graph `instagram_oembed`; token requirement has flip-flopped in 2026 (undocumented tokenless reports) and thumbnail fields were removed Nov 2025 ([feedframer](https://feedframer.com/guides/instagram-post-embed), [WPMayor](https://wpmayor.com/meta-tokenless-oembed-wordpress/)) | `/p/ID/embed/` URL loadable | Screenshot | Do not depend on oEmbed; use embed URL + screenshot, mark best-effort |
| Figma | `GET /v1/oembed`, needs OAuth scope `file_metadata:read` ([docs](https://developers.figma.com/docs/rest-api/oembed-endpoints/)); `figma.com` itself sends `SAMEORIGIN` | Use Figma's embed host URL (as tldraw does) | Screenshot | Token + scope required for thumbnail |
| CodePen | oEmbed behind Cloudflare challenge for plain curl; `/embed/` path used by tldraw | `/embed/ID` | Screenshot | Treat endpoint as unreliable server-side; derive embed URL by pattern |
| Arbitrary URL | oEmbed discovery via `<link rel="alternate" type="application/json+oembed">` or `Link` header | maybe | `og:image` | **Probe framing headers server-side** (below) |

**Frame-blocking is not detectable from the client** (cross-origin `onload`/`onerror` tell you nothing). At insert time, a server `HEAD`/`GET` reads `X-Frame-Options` and CSP `frame-ancestors`. Observed today: `github.com` sends `X-Frame-Options: deny`, `x.com` and `figma.com` send `SAMEORIGIN`; `youtube.com/embed/*` sends none. Store `framable: 'yes'|'no'|'unknown'` + timestamp; `no` => bookmark card (poster + "Open in new tab"). Re-check lazily (headers change).

## 6. Recommendation

**Hybrid LOD, three states per embed card:**

1. **`poster`** (default, all cards): Pixi sprite with the poster texture + a play/globe badge. Participates in culling, LOD, selection, z-order like any media card. Zero DOM.
2. **`armed`** (optional): card is selected/hovered or is the best live candidate; DOM iframe is created hidden-but-loading (`visibility:hidden`) so the switch is instant.
3. **`live`**: iframe visible in the camera-synced DOM layer above the canvas; Pixi sprite hidden (or faded once iframe `load` fires, to avoid a flash). Pointer events off until the user opts in.

Reuse the existing `<video>` overlay machinery: same layer container, same `matrix(a,b,c,d,e,f)` camera sync, same pool/eviction code. Make the iframe a second pooled element type, not a new system.

### Activation policy (starting values, tune with measurements)

| Rule | Value |
|---|---|
| Eligible for `live` | on-screen size >= 320x200 CSS px **and** >= ~12% of viewport area, **or** explicitly selected/focused at any size |
| Never live while | camera is moving (pan/zoom/pinch in progress) or zoom-gesture velocity > threshold; wait ~250 ms idle |
| Max live iframes | **4** desktop / **1** touch. Count audio/video-playing embeds as pinned |
| Eviction | LRU by last focus; on evict, **destroy** (remove node, `src="about:blank"` first) and return to `poster`. Do not `display:none` (Excalidraw does; the document and its process stay alive) |
| Cull | Off-screen => destroy, unless currently playing media and the user pinned it |
| Interaction | Live iframes start `pointer-events: none` so wheel/drag pan the board. **Click selects. Double-click / Enter / an "Interact" button sets `pointer-events: auto`** (tldraw and Excalidraw model). Exit: click outside the iframe, or a visible "Done" button |
| Zoomed far out | Below ~0.25 screen scale never mount, regardless of selection |

Gotchas for the interaction model:
- **Keys and wheel inside a cross-origin iframe never reach the parent.** Esc only works if focus is outside the iframe; offer a button and click-outside. Pinch-zoom (ctrl+wheel) inside the iframe won't zoom the board.
- Clicks on the iframe do not bubble; use a transparent shield `<div>` over the iframe in non-interactive mode if you need hover/drag on the card body (iframe `pointer-events:none` already gives this, since the event hits the wrapper beneath).
- Drag/resize handles must live on the wrapper, outside the iframe box (drawn in DOM, since Pixi cannot draw above the DOM layer).

### Layering and z-order

- The DOM layer is a single slab: it is wholly above or wholly below the canvas. **Put it above.** Consequence: Pixi content (other cards overlapping, selection chrome, connectors) cannot render over a live iframe.
- Mitigation that fits the policy: **a live card is promoted to the top** (z-order is a temporary property of the live state), and selection/resize handles for it are DOM elements in the same layer. Cards in `poster` state keep correct z-order in WebGL.
- Alternative (hole-punch): canvas above with `alpha:true`, iframe layer below, card rect cleared transparent. Gives correct z-order for free but the canvas then eats all pointer events, so interactive mode must still lift the iframe above. Not worth the complexity.
- Rotated cards: iframe takes the same `rotate()`; keep rotation for posters but consider flattening to 0 while live.

### Crispness and scale

- Lay the iframe out at the card's **world size** (e.g. 800x450), apply the camera as the CSS `matrix()` (like Excalidraw's `translate+scale`). Text re-rasterizes at the new scale; avoid `will-change: transform` on the iframe wrapper, which can freeze raster scale and blur on zoom-in (verify in your target Chrome/Safari).
- Alternative for media-heavy embeds: lay out at screen size and counter-scale (`scale(1/k)`, clamp k to 0.75..4, as Excalidraw does for video). It keeps the embedded page's responsive layout at the size the user actually sees; costs a reload-free but layout-heavy resize on every zoom step, so apply only at zoom end (debounced).
- Cap iframe layout size (e.g. <= 2048 px per side) to bound raster memory.

### Security attributes

| Content | `sandbox` | Other |
|---|---|---|
| **Allowlisted provider** (YouTube, Vimeo, Spotify, Figma, CodePen, ...) | `allow-scripts allow-same-origin allow-forms allow-popups allow-presentation` | `allow="autoplay; encrypted-media; picture-in-picture; clipboard-write; fullscreen"` per provider; `referrerpolicy="strict-origin-when-cross-origin"`; `allowfullscreen` |
| **Arbitrary URL** (only if `framable=yes`) | `allow-scripts allow-same-origin allow-forms allow-popups` | empty `allow`; never `allow-top-navigation*`, `allow-modals`, `allow-pointer-lock`, `allow-downloads`, `allow-popups-to-escape-sandbox` |
| **User snippet** | `allow-scripts` only (no `allow-same-origin`, no `allow-forms`, no `allow-popups`) | `srcdoc=`; inject `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src https: data:">`; empty `allow` |

Rules:
- `allow-same-origin` is safe only when the framed origin differs from the app origin. **Never combine `allow-scripts` + `allow-same-origin` on `srcdoc` or same-origin URLs**: the framed script can remove its own sandbox (this is the Excalidraw CVE class).
- The sandbox profile is **derived at render time from `source.type` + provider allowlist, never stored in the document**, so a tampered/shared board cannot escalate.
- Defense in depth for snippets: serve them from a separate cookieless origin (`https://snippets.<domain>/frame.html` + `postMessage`) instead of `srcdoc`, so even a sandbox bug lands on an empty origin.
- Sandboxed opaque-origin frames have no `localStorage`/cookies; snippets using them will throw. Document it in the editor.
- Normalize URLs to `https:`; reject `javascript:`, `data:`, `file:`, `blob:` for `url` embeds. Keep the original URL and the derived `embedUrl` separate (as tldraw does).
- `credentialless` iframes ([Chrome 110+](https://developer.chrome.com/blog/iframe-credentialless)) only matter if the app becomes cross-origin isolated (COEP) for SharedArrayBuffer/WASM threads: then cross-origin embeds without CORP will refuse to load unless `credentialless` is set. Plan for it if you enable COOP/COEP.
- Export/share: public boards render `poster` only (like tldraw's SVG export draws blank placeholders), and the iframe loads only for viewers.

## 7. User-authored HTML snippets

- **Render:** `<iframe sandbox="allow-scripts" srcdoc="...">` (profile above). Opaque origin: scripts run, no access to cookies/storage/parent DOM ([MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)).
- **Poster (preferred, my design, untested):** inject a small bootstrap into `srcdoc` that, on `load` + idle, runs a bundled DOM rasterizer (modern-screenshot/html-to-image) on its **own** document and `postMessage`s a PNG/WebP blob to the parent. The parent checks `event.source === iframe.contentWindow`, size/MIME limits, then stores it as the poster. Works with JS-generated content and needs no server. Caveat: the snippet can post a fake image to its own card (harmless), and `foreignObject` rasterizing has Safari quirks (see [WebKit 43911](https://bugs.webkit.org/show_bug.cgi?id=43911)).
- **Poster (fallback):** Cloudflare Browser Rendering `/screenshot` with the `html` param (runs JS, no snapshot script needed, but metered).
- **Sanitized static variant:** if the editor offers a "no scripts" mode, sanitize with DOMPurify, render in a hidden same-origin container, snapshot with D, and (Chromium + origin trial) optionally upload as texture via HTML-in-Canvas. Do not do this for script-enabled snippets (the sandbox would block readback).
- **Size limits:** cap source at ~256 KB, cap `srcdoc` iframe layout size, throttle `requestAnimationFrame`-heavy snippets by destroying the iframe when not live.

## 8. Element model

```ts
type EmbedElement = {
  id: string; kind: 'embed';
  x: number; y: number; w: number; h: number; rotation?: number;
  source:
    | { type: 'url'; url: string;            // what the user pasted (https only)
        embedUrl?: string;                   // derived provider embed URL
        provider?: 'youtube' | 'vimeo' | 'spotify' | 'figma' | 'codepen' | 'x' | 'instagram' | 'generic';
        framable?: 'yes' | 'no' | 'unknown'; framableCheckedAt?: number }
    | { type: 'html'; html: string };        // user snippet, executed only in sandbox
  poster?: {                                 // our own storage, CORS-enabled
    src: string; w: number; h: number;
    origin: 'oembed' | 'og' | 'screenshot' | 'snapshot' | 'generated';
    capturedAt: number;
  };
  aspect: number;                            // w/h, from oEmbed/poster/known provider
  lockAspect: boolean;                       // true for video providers
  interactive: 'click' | 'always' | 'never'; // activation mode; default 'click'
  title?: string;
};
// NOT stored: sandbox flags, allow list, live/armed/poster state (derived at runtime).
```

`interactive: 'never'` => card stays a poster forever (safe for shared/read-only boards). `'always'` is for the owner's pinned embeds and still obeys the live cap.

## 9. Memory / CPU notes

- Cross-site iframes are out-of-process under Site Isolation (desktop since Chrome 67) ([OOPIF design doc](https://chromium.org/developers/design-documents/oop-iframes)); that is the main cost. Third-party figures of 20-100 MB per subframe process are unverified: **measure** with Chrome Task Manager on your target embeds before fixing the cap.
- `loading="lazy"` helps only for iframes below the fold in normal flow and thresholds vary by connection ([Chromium blog](https://blog.chromium.org/2019/10/automatically-lazy-loading-offscreen.html)). With explicit mount/unmount it is redundant; set it anyway as a harmless guard.
- Reparenting an iframe reloads it, unless `Node.moveBefore` is used (Chromium 133+, Firefox 144+) and the node stays connected ([tldraw](https://tldraw.dev/examples/persistent-iframe-shape)). Avoid moving live iframes between containers (e.g. when promoting z-order, reorder via `z-index`, not DOM moves).
- Keep one shared transform on the layer container for pan (compositor-only) and per-iframe transforms only for zoom/size changes.

## 10. Build order

1. `EmbedElement` + poster-only rendering (URL paste -> oEmbed/og:image -> poster, bookmark fallback). Ships value alone.
2. Live iframe state in the existing DOM overlay: pooled element, activation policy, click-to-interact, provider sandbox profiles, framing probe.
3. Snippets (`srcdoc` sandbox + bootstrap snapshot for the poster).
4. Server screenshot queue for pages without thumbnails.
5. HTML-in-Canvas experiment behind a flag, only after Chrome stable ships it.

## Sources

- WICG explainer: https://github.com/WICG/html-in-canvas; draft spec: https://wicg.github.io/html-in-canvas/
- Chrome OT post, changes, and Intent to Experiment: https://developer.chrome.com/blog/html-in-canvas-origin-trial, https://developer.chrome.com/blog/html-in-canvas-ot-changes, https://groups.google.com/a/chromium.org/g/blink-dev/c/t_nGEmJ_v4s
- tldraw: https://tldraw.dev/sdk-features/embed-shape, https://tldraw.dev/examples/persistent-iframe-shape
- Excalidraw source: https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/App.tsx; CVE: https://security-tracker.debian.org/tracker/CVE-2024-32472
- FigJam EmbedData: https://developers.figma.com/docs/plugins/api/EmbedData; Figma oEmbed: https://developers.figma.com/docs/rest-api/oembed-endpoints/
- oEmbed spec: https://oembed.com/
- Cloudflare Browser Rendering: https://developers.cloudflare.com/browser-rendering/rest-api/screenshot-endpoint/, https://developers.cloudflare.com/browser-rendering/limits/
- Iframe `credentialless`: https://developer.chrome.com/blog/iframe-credentialless; CSP sandbox: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox
- OOPIFs: https://chromium.org/developers/design-documents/oop-iframes; lazy loading: https://blog.chromium.org/2019/10/automatically-lazy-loading-offscreen.html
- Meta oEmbed state: https://feedframer.com/guides/instagram-post-embed, https://wpmayor.com/meta-tokenless-oembed-wordpress/
