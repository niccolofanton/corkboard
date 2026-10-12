// When may a video card play on hover or selection? Pure rules, shared by the controller and its tests.
// No DOM, no timers.

// Hover must be held this long before a card starts playing (a pointer sweeping across the canvas must
// not start a stream per card).
export const HOVER_DELAY_MS = 300;
// Below this on-screen width a card is too small to be worth a stream.
export const MIN_SCREEN_PX = 160;

export interface VideoCardState {
  id: string;
  hasVideo: boolean;
  // CSS px on screen (world width x zoom).
  screenWidth: number;
  // The always-playing pool already plays this card, muted, and sound is off: the hover / selection
  // overlay would only restart the same picture over itself.
  covered?: boolean;
}

export type PlaybackSource = 'selection' | 'hover';

export interface PolicyInput {
  // Edit gestures (drags, carries) block playback through `enabled`; touch has no hover and no
  // selection playback; a moving camera hides the overlay until it settles.
  enabled: boolean;
  touch: boolean;
  // Hover playback switch; selection playback is not affected.
  hoverPlay?: boolean;
  cameraMoving: boolean;
  selection: readonly string[];
  hoverId: string | null;
  card(id: string): VideoCardState | null;
}

export interface PlaybackWant {
  // A single selected video card: plays at once.
  immediate: string | null;
  // The hovered video card: plays after HOVER_DELAY_MS, unless it already plays.
  delayed: string | null;
}

export function isPlayable(card: VideoCardState | null): boolean {
  return (
    card !== null && card.hasVideo && card.covered !== true && card.screenWidth >= MIN_SCREEN_PX
  );
}

// Selection beats hover, but only when the selected card can actually play: a selected image card
// does not stop a hovered video from starting.
export function wantedPlayback(input: PolicyInput): PlaybackWant {
  const none: PlaybackWant = { immediate: null, delayed: null };
  if (!input.enabled || input.touch || input.cameraMoving) return none;
  if (input.selection.length === 1) {
    const id = input.selection[0];
    if (isPlayable(input.card(id))) return { immediate: id, delayed: null };
  }
  const hover = input.hoverId;
  if (input.hoverPlay === false) return none;
  if (hover !== null && isPlayable(input.card(hover))) return { immediate: null, delayed: hover };
  return none;
}
