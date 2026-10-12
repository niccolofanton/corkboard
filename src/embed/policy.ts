// Which embed cards hold a live iframe? Pure rules, shared by the layer and its tests. No DOM, no timers.
//
// A card goes live when it is on screen, at least MIN_LIVE_W x MIN_LIVE_H CSS px big (or selected, at any
// size above a minimum zoom), and the camera is still. At most `max` iframes are live at once: the rest
// stay posters. A card that is live keeps its place against newcomers (an LRU by last focus), and a
// selected one always wins.

export const MAX_LIVE_DESKTOP = 4;
export const MAX_LIVE_TOUCH = 1;
export const MIN_LIVE_W = 320;
export const MIN_LIVE_H = 200;
// Below this zoom nothing mounts, selected or not.
export const MIN_LIVE_SCALE = 0.25;
// A live card is kept until it shrinks under this fraction of the size that earned it the iframe, so a
// card hovering around the threshold does not flicker between poster and iframe.
export const KEEP_FACTOR = 0.6;

export interface PolicyCard {
  id: string;
  // CSS px on screen.
  screenW: number;
  screenH: number;
  onScreen: boolean;
  selected: boolean;
  // In interact mode: always kept, ahead of everything.
  interacting: boolean;
  // False: a bookmark (the page refuses framing, or there is nothing to load).
  frameable: boolean;
  live: boolean;
  // Last time the card was selected, interacted with or mounted (ms; larger = more recent).
  lastUsed: number;
}

export interface PolicyInput {
  cards: readonly PolicyCard[];
  // Pan, zoom or pinch in progress: nothing changes until it settles.
  cameraMoving: boolean;
  // Camera scale.
  scale: number;
  max: number;
  minW?: number;
  minH?: number;
  minScale?: number;
}

export interface PolicyPlan {
  mount: string[];
  destroy: string[];
}

export function isEligible(c: PolicyCard, scale: number, o: Pick<PolicyInput, 'minW' | 'minH' | 'minScale'>): boolean {
  if (!c.frameable || !c.onScreen) return false;
  if (scale < (o.minScale ?? MIN_LIVE_SCALE)) return false;
  if (c.interacting || c.selected) return true;
  const k = c.live ? KEEP_FACTOR : 1;
  return c.screenW >= (o.minW ?? MIN_LIVE_W) * k && c.screenH >= (o.minH ?? MIN_LIVE_H) * k;
}

export function planLive(input: PolicyInput): PolicyPlan {
  const plan: PolicyPlan = { mount: [], destroy: [] };
  if (input.cameraMoving) return plan;
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
  const wanted = new Set(eligible.slice(0, Math.max(0, Math.floor(input.max))).map((c) => c.id));
  for (const c of input.cards) {
    if (wanted.has(c.id) && !c.live) plan.mount.push(c.id);
    else if (!wanted.has(c.id) && c.live) plan.destroy.push(c.id);
  }
  return plan;
}
