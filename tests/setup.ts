// jsdom has no canvas: its `getContext` logs "Not implemented" (Pixi probes one at import, the embed tile draws on
// one). Answer null instead, as a browser without that context would, so the test log stays readable.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}
