/** A card as the stage tracks it. */
export interface BoardCard {
  // Dense slot, assigned by the stage and recycled when the element is removed.
  id: number;
  // World size (long side drives the baked corner radius).
  w: number;
  h: number;
  // ThumbHash bytes (<= 25 B): the L0 placeholder, which also carries the aspect ratio.
  thumbhash: Uint8Array | undefined;
  // Rendition URLs. A missing URL means "not requestable": the level is simply not wanted.
  l1Url: string | undefined;
  l2Url: string | undefined;
  l3Url: string | undefined;
  // Corner radius in world px.
  radius: number;
}
