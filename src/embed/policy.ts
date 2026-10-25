// Which embed cards hold a mounted iframe? Pure rules, shared by the layer and its tests. No DOM, no timers.
//
// Two tiers, plus a state a parked card can be in:
//   ACTIVE  a card is on screen, at least `minW` x `minH` CSS px big (or selected, at any size above a
//           minimum zoom), and the camera is still. (The layer passes 0 for both: any card in view.) At most `max` at once. A card that is active keeps its
//           place against newcomers (an LRU by last focus), and a selected one always wins. Only active cards
//           are ever newly mounted.
//   PARKED  a card that is already mounted, can still be framed and is not active: too small, too far out,
//           partly or wholly off screen, or out of the `max` budget. Its iframe stays mounted but inert and
//           keeps showing its last frame, because a cross-origin page cannot be screenshotted to a poster. A
//           card that has been live is never swapped back to its preview just for being small.
//   CULLED  a parked card that is off screen (outside the viewport grown by a margin, see layer.ts). The layer
//           hides it (`display: none`) so it stops rendering, but the document stays alive and comes back as it
//           was. Culled cards are bounded by `maxOffscreen`, most recently seen first.
// Parked cards are bounded by `maxMounted` (active + parked): on overflow the least valuable parked ones are
// destroyed (off screen first, then least recently used) and only then does the poster show again.

export const MAX_LIVE_DESKTOP = 12;
export const MAX_LIVE_TOUCH = 3;
// Mounted iframes in total (active + parked).
export const MAX_MOUNTED_DESKTOP = 24;
export const MAX_MOUNTED_TOUCH = 6;
// Culled (off screen) iframes kept alive, a subset of the mounted ones.
export const MAX_OFFSCREEN_DESKTOP = 64;
export const MAX_OFFSCREEN_TOUCH = 12;
export const MIN_LIVE_W = 320;
export const MIN_LIVE_H = 200;
// Below this zoom nothing mounts, selected or not.
export const MIN_LIVE_SCALE = 0.25;
// A live card is kept until it shrinks under this fraction of the size that earned it the iframe, so a
// card hovering around the threshold does not flicker between poster and iframe.
export const KEEP_FACTOR = 0.6;

export interface PolicyCard {
  id: string;
  // CSS px on screen: the part of the card that is in view.
  screenW: number;
  screenH: number;
  // In view or inside the cull margin (the layer grows the viewport by it). screenW/screenH stay the truly
  // visible part: negative when the card is only in the margin, so such a card is never eligible.
  onScreen: boolean;
  selected: boolean;
  // In interact mode: always kept, ahead of everything.
  interacting: boolean;
  // False: a bookmark (the page refuses framing, or there is nothing to load).
  frameable: boolean;
  live: boolean;
  // Last time the card was selected, interacted with or mounted (ms; larger = more recent).
  lastUsed: number;
  // Last time the card was on screen (larger = more recent); orders the off-screen ones. Falls back to lastUsed.
  lastSeen?: number;
}

export interface PolicyInput {
  cards: readonly PolicyCard[];
  // Pan, zoom or pinch in progress: nothing changes until it settles.
  cameraMoving: boolean;
  // Camera scale.
  scale: number;
  // Active cap (Infinity: no cap).
  max: number;
  // Mounted cap, active + parked (default 3 x max; Infinity: no cap).
  maxMounted?: number;
  // Off-screen mounted cards kept (culled), within maxMounted (default maxMounted; Infinity: no extra cap).
  maxOffscreen?: number;
  minW?: number;
  minH?: number;
  minScale?: number;
}

export interface PolicyPlan {
  mount: string[];
  destroy: string[];
  // Ids that are mounted and parked once the plan is applied (the rest of the mounted ones are active).
  parked: string[];
  // ... of which these are off screen (the layer keeps them hidden). Always a subset of `parked`.
  culled: string[];
}

export function isEligible(c: PolicyCard, scale: number, o: Pick<PolicyInput, 'minW' | 'minH' | 'minScale'>): boolean {
  if (!c.frameable || !c.onScreen) return false;
  // Only in the cull margin: not in view.
  if (c.screenW < 0 || c.screenH < 0) return false;
  if (scale < (o.minScale ?? MIN_LIVE_SCALE)) return false;
  if (c.interacting || c.selected) return true;
  const k = c.live ? KEEP_FACTOR : 1;
  return c.screenW >= (o.minW ?? MIN_LIVE_W) * k && c.screenH >= (o.minH ?? MIN_LIVE_H) * k;
}

export function planLive(input: PolicyInput): PolicyPlan {
  const plan: PolicyPlan = { mount: [], destroy: [], parked: [], culled: [] };
  if (input.cameraMoving) return plan;
  const max = Math.max(0, Math.floor(input.max));
  const maxMounted = Math.max(0, Math.floor(input.maxMounted ?? max * 3));
  const eligible = input.cards.filter((c) => isEligible(c, input.scale, input));
  eligible.sort(
    (a, b) =>
      Number(b.interacting) - Number(a.interacting) ||
      Number(b.selected) - Number(a.selected) ||
      Number(b.live) - Number(a.live) ||
      b.lastUsed - a.lastUsed ||
      b.screenW * b.screenH - a.screenW * a.screenH ||
      (a.id < b.id ? -1 : 1),
  );
  const active = new Set(eligible.slice(0, max).map((c) => c.id));
  // Whatever is mounted, frameable and not active is a parking candidate, at any size, zoom or position.
  const candidates = input.cards.filter((c) => c.live && c.frameable && !active.has(c.id));
  const room = Math.max(0, maxMounted - active.size);
  const maxOffscreen = Math.max(0, Math.floor(input.maxOffscreen ?? maxMounted));
  // On screen ones first, as they were; they are never limited by maxOffscreen.
  const onScreen = candidates.filter((c) => c.onScreen);
  onScreen.sort(
    (a, b) =>
      b.lastUsed - a.lastUsed || b.screenW * b.screenH - a.screenW * a.screenH || (a.id < b.id ? -1 : 1),
  );
  // Off screen: the most recently seen stay, up to maxOffscreen and what is left of maxMounted.
  const offScreen = candidates.filter((c) => !c.onScreen);
  offScreen.sort(
    (a, b) =>
      (b.lastSeen ?? b.lastUsed) - (a.lastSeen ?? a.lastUsed) ||
      b.lastUsed - a.lastUsed ||
      b.screenW * b.screenH - a.screenW * a.screenH ||
      (a.id < b.id ? -1 : 1),
  );
  const parkedOn = onScreen.slice(0, room);
  const culled = new Set(offScreen.slice(0, Math.min(maxOffscreen, room - parkedOn.length)).map((c) => c.id));
  const parked = new Set([...parkedOn.map((c) => c.id), ...culled]);
  for (const c of input.cards) {
    if (active.has(c.id)) {
      if (!c.live) plan.mount.push(c.id);
    } else if (parked.has(c.id)) {
      plan.parked.push(c.id);
      if (culled.has(c.id)) plan.culled.push(c.id);
    } else if (c.live) plan.destroy.push(c.id);
  }
  return plan;
}
