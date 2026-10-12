import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOVER_DELAY_MS,
  MIN_SCREEN_PX,
  isPlayable,
  wantedPlayback,
  type VideoCardState,
} from '../../src/video/videoPolicy';
import { VideoController } from '../../src/video/videoController';

interface CardSpec {
  hasVideo: boolean;
  screenWidth: number;
}

function harness(initial: Record<string, CardSpec>) {
  // Per-test copies: some tests resize or strip the cards.
  const cards: Record<string, CardSpec> = {};
  for (const [k, v] of Object.entries(initial)) cards[k] = { ...v };
  const log: string[] = [];
  const ctrl = new VideoController({
    show: (id) => void log.push(`show:${id}`),
    hide: () => void log.push('hide'),
    card: (id): VideoCardState | null => (cards[id] ? { id, ...cards[id] } : null),
  });
  return { cards, log, ctrl };
}

const CARDS = {
  a: { hasVideo: true, screenWidth: 300 },
  b: { hasVideo: true, screenWidth: 200 },
  small: { hasVideo: true, screenWidth: 159 },
  img: { hasVideo: false, screenWidth: 400 },
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('policy', () => {
  it('uses the documented constants', () => {
    expect(HOVER_DELAY_MS).toBe(300);
    expect(MIN_SCREEN_PX).toBe(160);
  });

  it('isPlayable needs a stored video and at least 160 screen px', () => {
    expect(isPlayable(null)).toBe(false);
    expect(isPlayable({ id: 'x', hasVideo: true, screenWidth: 159.99 })).toBe(false);
    expect(isPlayable({ id: 'x', hasVideo: true, screenWidth: 160 })).toBe(true);
    expect(isPlayable({ id: 'x', hasVideo: false, screenWidth: 1000 })).toBe(false);
  });

  it('a card the ambient pool already plays (sound off) is left to it: no hover or selection overlay', () => {
    const covered = (id: string): VideoCardState => ({
      id,
      hasVideo: true,
      screenWidth: 400,
      covered: true,
    });
    expect(isPlayable(covered('x'))).toBe(false);
    const base = { enabled: true, touch: false, cameraMoving: false, card: covered };
    expect(wantedPlayback({ ...base, selection: [], hoverId: 'x' })).toEqual({
      immediate: null,
      delayed: null,
    });
    expect(wantedPlayback({ ...base, selection: ['x'], hoverId: null })).toEqual({
      immediate: null,
      delayed: null,
    });
  });

  it('wantedPlayback: selection beats hover only when the selected card can play', () => {
    const card = (id: string): VideoCardState | null =>
      id in CARDS ? { id, ...CARDS[id as keyof typeof CARDS] } : null;
    const base = {
      enabled: true,
      touch: false,
      cameraMoving: false,
      selection: [] as string[],
      hoverId: null as string | null,
      card,
    };
    expect(wantedPlayback(base)).toEqual({ immediate: null, delayed: null });
    expect(wantedPlayback({ ...base, hoverId: 'a' })).toEqual({ immediate: null, delayed: 'a' });
    expect(wantedPlayback({ ...base, selection: ['a'], hoverId: 'b' })).toEqual({
      immediate: 'a',
      delayed: null,
    });
    expect(wantedPlayback({ ...base, selection: ['img'], hoverId: 'b' })).toEqual({
      immediate: null,
      delayed: 'b',
    });
    expect(wantedPlayback({ ...base, selection: ['a', 'b'] })).toEqual({
      immediate: null,
      delayed: null,
    });
    for (const blocked of [{ enabled: false }, { touch: true }, { cameraMoving: true }]) {
      expect(wantedPlayback({ ...base, ...blocked, selection: ['a'], hoverId: 'b' })).toEqual({
        immediate: null,
        delayed: null,
      });
    }
  });
});

describe('hover', () => {
  it('plays a video card >= 160 px after 300 ms of hover', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(299);
    expect(ctrl.playingId).toBeNull();
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ctrl.playingId).toBe('a');
    expect(log).toEqual(['show:a']);
  });

  it('never plays cards under 160 px, without a video, or unknown', () => {
    const { ctrl, log } = harness(CARDS);
    for (const id of ['small', 'img', 'ghost']) {
      ctrl.setHover(id);
      vi.advanceTimersByTime(1000);
    }
    expect(log).toEqual([]);
    expect(ctrl.playingId).toBeNull();
  });

  it('re-checks the card when the timer fires', () => {
    const { ctrl, log, cards } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(200);
    cards.a.screenWidth = 100;
    vi.advanceTimersByTime(100);
    expect(log).toEqual([]);
    cards.a.screenWidth = 300;
    cards.a.hasVideo = false;
    ctrl.setHover(null);
    ctrl.setHover('a');
    vi.advanceTimersByTime(1000);
    expect(log).toEqual([]);
  });

  it('leaving before 300 ms cancels the timer', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(200);
    ctrl.setHover(null);
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
  });

  it('leaving stops a hover-started playback', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(300);
    ctrl.setHover(null);
    expect(ctrl.playingId).toBeNull();
    expect(log).toEqual(['show:a', 'hide']);
  });

  it('moving to another card restarts the delay for the new one only', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(200);
    ctrl.setHover('b');
    vi.advanceTimersByTime(299);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['show:b']);
  });

  it('hovering another video while one plays stops it at once and delays the next', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(300);
    ctrl.setHover('b');
    expect(log).toEqual(['show:a', 'hide']);
    expect(ctrl.playingId).toBeNull();
    vi.advanceTimersByTime(300);
    expect(log).toEqual(['show:a', 'hide', 'show:b']);
  });

  it('hovering the same card again does not restart the delay', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(200);
    ctrl.setHover('a');
    vi.advanceTimersByTime(100);
    expect(log).toEqual(['show:a']);
  });
});

describe('selection', () => {
  it('a single selected video card >= 160 px plays at once, with no timer', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['a']);
    expect(log).toEqual(['show:a']);
    expect(ctrl.playingId).toBe('a');
    vi.advanceTimersByTime(1000);
    expect(log).toEqual(['show:a']);
  });

  it('does not play for a multi-selection, an image card, or a card under 160 px', () => {
    const { ctrl, log } = harness(CARDS);
    for (const sel of [['a', 'b'], ['img'], ['small'], ['ghost'], []]) {
      ctrl.setSelection(sel);
      vi.advanceTimersByTime(1000);
    }
    expect(log).toEqual([]);
  });

  it('stops when the selection is cleared or grows to several cards', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['a']);
    ctrl.setSelection([]);
    ctrl.setSelection(['a']);
    ctrl.setSelection(['a', 'b']);
    expect(log).toEqual(['show:a', 'hide', 'show:a', 'hide']);
  });

  it('is not stopped by the pointer leaving, unlike a hover playback', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['a']);
    ctrl.setHover('a');
    ctrl.setHover(null);
    vi.advanceTimersByTime(1000);
    expect(ctrl.playingId).toBe('a');
    expect(log).toEqual(['show:a']);
  });

  it('switching the selection to another playable video swaps the playback', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['a']);
    ctrl.setSelection(['b']);
    expect(log).toEqual(['show:a', 'show:b']);
    expect(ctrl.playingId).toBe('b');
  });

  it('copies the selection array it is given', () => {
    const { ctrl } = harness(CARDS);
    const sel = ['img'];
    ctrl.setSelection(sel);
    sel[0] = 'a';
    ctrl.recheck();
    expect(ctrl.playingId).toBeNull();
  });
});

describe('priority', () => {
  it('selection beats hover: a hover on another card never plays and arms no timer', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['a']);
    ctrl.setHover('b');
    vi.advanceTimersByTime(2000);
    expect(log).toEqual(['show:a']);
    expect(ctrl.playingId).toBe('a');
  });

  it('a hover that started first yields to a later selection', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('b');
    vi.advanceTimersByTime(300);
    ctrl.setSelection(['a']);
    expect(log).toEqual(['show:b', 'show:a']);
    ctrl.setHover(null);
    expect(ctrl.playingId).toBe('a');
  });

  it('a selection that cannot play does not block hover playback', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['img']);
    ctrl.setHover('a');
    vi.advanceTimersByTime(300);
    expect(log).toEqual(['show:a']);
  });

  it('selecting the card that already plays from hover keeps it playing past the pointer leaving', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(300);
    ctrl.setSelection(['a']);
    ctrl.setHover(null);
    expect(log).toEqual(['show:a']);
    expect(ctrl.playingId).toBe('a');
  });

  it('deselecting while the pointer is still on the card keeps it playing as a hover', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['a']);
    ctrl.setHover('a');
    ctrl.setSelection([]);
    expect(log).toEqual(['show:a']);
    ctrl.setHover(null);
    expect(log).toEqual(['show:a', 'hide']);
  });

  it('at most one video plays', () => {
    const { ctrl, log } = harness(CARDS);
    let playing = 0;
    ctrl.setHover('a');
    vi.advanceTimersByTime(300);
    ctrl.setSelection(['b']);
    ctrl.setHover('a');
    vi.advanceTimersByTime(1000);
    // show a, show b (replaces a), nothing else.
    for (const entry of log) {
      if (entry.startsWith('show')) playing = 1;
      if (entry === 'hide') playing = 0;
      expect(playing).toBeLessThanOrEqual(1);
    }
    expect(ctrl.playingId).toBe('b');
  });
});

describe('camera moving', () => {
  it('hides a selection playback at once and brings it back on settle', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['a']);
    ctrl.setCameraMoving(true);
    expect(log).toEqual(['show:a', 'hide']);
    expect(ctrl.playingId).toBeNull();
    ctrl.setCameraMoving(false);
    expect(log).toEqual(['show:a', 'hide', 'show:a']);
  });

  it('hides a hover playback and restarts its 300 ms delay on settle', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(300);
    ctrl.setCameraMoving(true);
    expect(log).toEqual(['show:a', 'hide']);
    vi.advanceTimersByTime(5000);
    ctrl.setCameraMoving(false);
    vi.advanceTimersByTime(299);
    expect(log).toEqual(['show:a', 'hide']);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['show:a', 'hide', 'show:a']);
  });

  it('cancels a pending hover delay when the camera starts moving', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(200);
    ctrl.setCameraMoving(true);
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
  });

  it('a hover set while the camera moves waits for the settle', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setCameraMoving(true);
    ctrl.setHover('a');
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
    ctrl.setCameraMoving(false);
    vi.advanceTimersByTime(300);
    expect(log).toEqual(['show:a']);
  });

  it('settling with nothing to play does nothing; repeated calls are idempotent', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setCameraMoving(true);
    ctrl.setCameraMoving(true);
    ctrl.setCameraMoving(false);
    ctrl.setCameraMoving(false);
    expect(log).toEqual([]);
  });

  it('a selection change while moving plays on settle, not before', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setCameraMoving(true);
    ctrl.setSelection(['a']);
    expect(log).toEqual([]);
    ctrl.setCameraMoving(false);
    expect(log).toEqual(['show:a']);
  });
});

describe('touch', () => {
  it('never plays on hover or selection while touch is on', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setTouch(true);
    ctrl.setHover('a');
    ctrl.setSelection(['b']);
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
  });

  it('switching to touch hides a playing video; switching back re-evaluates', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['a']);
    ctrl.setTouch(true);
    expect(log).toEqual(['show:a', 'hide']);
    ctrl.setTouch(false);
    expect(log).toEqual(['show:a', 'hide', 'show:a']);
  });

  it('cancels a pending hover delay', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(100);
    ctrl.setTouch(true);
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
  });
});

describe('enabled', () => {
  it('disabling hides and blocks; enabling re-evaluates', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setSelection(['a']);
    ctrl.setEnabled(false);
    expect(log).toEqual(['show:a', 'hide']);
    ctrl.setSelection(['b']);
    ctrl.setHover('a');
    vi.advanceTimersByTime(5000);
    expect(log).toEqual(['show:a', 'hide']);
    ctrl.setEnabled(true);
    expect(log).toEqual(['show:a', 'hide', 'show:b']);
  });

  it('disabling cancels a pending hover delay; enabling restarts it', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(200);
    ctrl.setEnabled(false);
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
    ctrl.setEnabled(true);
    vi.advanceTimersByTime(299);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['show:a']);
  });
});

describe('recheck', () => {
  it('stops playback when the card drops under 160 px (zoom out)', () => {
    const { ctrl, log, cards } = harness(CARDS);
    ctrl.setSelection(['a']);
    cards.a.screenWidth = 159;
    ctrl.recheck();
    expect(log).toEqual(['show:a', 'hide']);
    cards.a.screenWidth = 160;
    ctrl.recheck();
    expect(log).toEqual(['show:a', 'hide', 'show:a']);
  });

  it('a hovered card that grows past 160 px starts after its delay', () => {
    const { ctrl, log, cards } = harness(CARDS);
    ctrl.setHover('small');
    vi.advanceTimersByTime(1000);
    cards.small.screenWidth = 200;
    ctrl.recheck();
    vi.advanceTimersByTime(299);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['show:small']);
  });

  it('does not restart a pending delay', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(200);
    ctrl.recheck();
    vi.advanceTimersByTime(100);
    expect(log).toEqual(['show:a']);
  });

  it('cancels a pending delay when the card shrank', () => {
    const { ctrl, log, cards } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(200);
    cards.a.screenWidth = 50;
    ctrl.recheck();
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
  });
});

describe('timers', () => {
  it('uses the injected setTimer / clearTimer', () => {
    const set = vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clear = vi.fn((h: ReturnType<typeof setTimeout>) => clearTimeout(h));
    const log: string[] = [];
    const ctrl = new VideoController({
      show: (id) => void log.push(`show:${id}`),
      hide: () => void log.push('hide'),
      card: (id) => ({ id, hasVideo: true, screenWidth: 300 }),
      setTimer: set as unknown as typeof setTimeout,
      clearTimer: clear as unknown as typeof clearTimeout,
    });
    ctrl.setHover('a');
    expect(set).toHaveBeenCalledWith(expect.any(Function), HOVER_DELAY_MS);
    ctrl.setHover(null);
    expect(clear).toHaveBeenCalledTimes(1);
    ctrl.setHover('a');
    vi.advanceTimersByTime(300);
    expect(log).toEqual(['show:a']);
  });

  it('can be driven by a manual clock', () => {
    const pending: Array<() => void> = [];
    const log: string[] = [];
    const ctrl = new VideoController({
      show: (id) => void log.push(`show:${id}`),
      hide: () => void log.push('hide'),
      card: (id) => ({ id, hasVideo: true, screenWidth: 300 }),
      setTimer: ((fn: () => void) => pending.push(fn)) as unknown as typeof setTimeout,
      clearTimer: (() => {}) as unknown as typeof clearTimeout,
    });
    ctrl.setHover('a');
    expect(pending).toHaveLength(1);
    pending[0]();
    expect(log).toEqual(['show:a']);
  });

  it('dispose cancels the delay and hides a playing video', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(100);
    ctrl.dispose();
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
    ctrl.setSelection(['a']);
    ctrl.dispose();
    expect(log).toEqual(['show:a', 'hide']);
  });
});

// Model check: whatever the sequence of events, once the timers have settled the controller plays
// exactly what the policy says, and never more than one video.
describe('pending (the hover delay)', () => {
  // The same as `harness`, with the overlay's notice of a hover that is waiting.
  function pendingHarness(initial: Record<string, CardSpec>) {
    const cards: Record<string, CardSpec> = {};
    for (const [k, v] of Object.entries(initial)) cards[k] = { ...v };
    const log: string[] = [];
    const ctrl = new VideoController({
      show: (id) => void log.push(`show:${id}`),
      hide: () => void log.push('hide'),
      pending: (id) => void log.push(`pending:${id}`),
      card: (id): VideoCardState | null => (cards[id] ? { id, ...cards[id] } : null),
    });
    return { cards, log, ctrl };
  }

  it('announces the card when the hover delay starts, and plays it when it is over', () => {
    const { ctrl, log } = pendingHarness(CARDS);
    ctrl.setHover('a');
    expect(log).toEqual(['pending:a']);
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(log).toEqual(['pending:a', 'show:a']);
  });

  it('says nothing of a card that cannot play, or a selection (it plays at once)', () => {
    const { ctrl, log } = pendingHarness(CARDS);
    for (const id of ['small', 'img', 'ghost']) ctrl.setHover(id);
    ctrl.setHover(null);
    ctrl.setSelection(['b']);
    expect(log).toEqual(['show:b']);
  });

  it('a hover that ends first cancels it', () => {
    const { ctrl, log } = pendingHarness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(200);
    ctrl.setHover(null);
    expect(log).toEqual(['pending:a', 'pending:null']);
    vi.advanceTimersByTime(5000);
    expect(log).toEqual(['pending:a', 'pending:null']);
  });

  it('moving to another card hands the wait over without a cancel in between', () => {
    const { ctrl, log } = pendingHarness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(100);
    ctrl.setHover('b');
    expect(log).toEqual(['pending:a', 'pending:b']);
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(log).toEqual(['pending:a', 'pending:b', 'show:b']);
  });

  it('a card that stopped being playable during the delay cancels it', () => {
    const { ctrl, log, cards } = pendingHarness(CARDS);
    ctrl.setHover('a');
    cards.a.screenWidth = 100;
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(log).toEqual(['pending:a', 'pending:null']);
    expect(ctrl.playingId).toBeNull();
  });

  it('a camera that starts moving, the touch or edit mode cancel it', () => {
    const { ctrl, log } = pendingHarness(CARDS);
    ctrl.setHover('a');
    ctrl.setCameraMoving(true);
    expect(log).toEqual(['pending:a', 'pending:null']);
    ctrl.setCameraMoving(false);
    expect(log).toEqual(['pending:a', 'pending:null', 'pending:a']);
    ctrl.setEnabled(false);
    expect(log.at(-1)).toBe('pending:null');
  });

  it('a hover while another card plays: it stops at once, the new one is announced', () => {
    const { ctrl, log } = pendingHarness(CARDS);
    ctrl.setHover('a');
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    ctrl.setHover('b');
    expect(log).toEqual(['pending:a', 'show:a', 'hide', 'pending:b']);
  });

  it('dispose cancels a wait in progress', () => {
    const { ctrl, log } = pendingHarness(CARDS);
    ctrl.setHover('a');
    ctrl.dispose();
    expect(log).toEqual(['pending:a', 'pending:null']);
  });
});

describe('model', () => {
  it('matches an independent model over random event sequences', () => {
    let seed = 20260709;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const ids = ['a', 'b', 'small', 'img', 'ghost'];
    for (let run = 0; run < 200; run++) {
      const { ctrl, log, cards } = harness(CARDS);
      let hover: string | null = null;
      let sel: string[] = [];
      let moving = false;
      let touch = false;
      let enabled = true;
      let shown: string | null = null;
      for (let step = 0; step < 25; step++) {
        const r = rnd();
        if (r < 0.25) {
          hover = rnd() < 0.3 ? null : ids[Math.floor(rnd() * ids.length)];
          ctrl.setHover(hover);
        } else if (r < 0.5) {
          sel = ids.filter(() => rnd() < 0.25);
          ctrl.setSelection(sel);
        } else if (r < 0.6) {
          moving = !moving;
          ctrl.setCameraMoving(moving);
        } else if (r < 0.67) {
          touch = !touch;
          ctrl.setTouch(touch);
        } else if (r < 0.74) {
          enabled = !enabled;
          ctrl.setEnabled(enabled);
        } else if (r < 0.85) {
          cards.a.screenWidth = rnd() < 0.5 ? 100 : 300;
          cards.b.screenWidth = rnd() < 0.5 ? 100 : 300;
          ctrl.recheck();
        } else {
          vi.advanceTimersByTime(Math.floor(rnd() * 400));
        }
        // The shown / hidden log never has two videos up at once.
        for (const entry of log.splice(0)) {
          if (entry.startsWith('show:')) shown = entry.slice(5);
          else shown = null;
        }
        expect(ctrl.playingId).toBe(shown);
      }
      vi.advanceTimersByTime(400);
      for (const entry of log.splice(0)) {
        if (entry.startsWith('show:')) shown = entry.slice(5);
        else shown = null;
      }
      const playable = (id: string): boolean => {
        const c = cards[id as keyof typeof cards];
        return !!c && c.hasVideo && c.screenWidth >= MIN_SCREEN_PX;
      };
      let expected: string | null = null;
      if (enabled && !touch && !moving) {
        if (sel.length === 1 && playable(sel[0])) expected = sel[0];
        else if (hover !== null && playable(hover)) expected = hover;
      }
      expect(ctrl.playingId).toBe(expected);
      expect(shown).toBe(expected);
    }
  });
});

describe('hover playback switch', () => {
  it('off: hover never plays, selection still does, back on resumes hover', () => {
    const { ctrl, log } = harness(CARDS);
    ctrl.setHoverPlay(false);
    ctrl.setHover('a');
    vi.advanceTimersByTime(HOVER_DELAY_MS + 10);
    expect(log).toEqual([]);
    ctrl.setSelection(['b']);
    expect(log).toEqual(['show:b']);
    ctrl.setSelection([]);
    expect(log).toEqual(['show:b', 'hide']);
    ctrl.setHoverPlay(true);
    vi.advanceTimersByTime(HOVER_DELAY_MS + 10);
    expect(log).toEqual(['show:b', 'hide', 'show:a']);
  });
});
