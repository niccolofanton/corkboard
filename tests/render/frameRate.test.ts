// The frame-rate monitor: how a window is read (slow / smooth, per display), and how it samples in bursts.
// Time is the rAF timestamp the test hands in; nothing here waits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameRateMonitor, HEARTBEAT_MS, type FrameWindow } from '../../src/render/frameRate';

function fakeRaf() {
  let cb: ((t: number) => void) | null = null;
  let id = 0;
  let t = 0;
  let wstart = 0;
  const call = (step: number): void => {
    t += step;
    const f = cb;
    cb = null;
    f?.(t);
  };
  return {
    raf: (f: (t: number) => void) => {
      cb = f;
      return ++id;
    },
    caf: vi.fn(() => {
      cb = null;
    }),
    running: () => cb !== null,
    // The first frame after a start only begins a window.
    first: (step: number) => {
      call(step);
      wstart = t;
    },
    // Frames of `step` ms until a window of at least one second has ended. Like a real 60 Hz display under load,
    // a slow window still has a couple of frames one vsync apart: the monitor reads the refresh from them.
    win: (step: number) => {
      for (let i = 0; i < 2 && cb !== null && step > 17; i++) call(1000 / 60);
      do call(step);
      while (cb !== null && t - wstart < 1000);
      wstart = t;
    },
    steady: (step: number) => {
      do call(step);
      while (cb !== null && t - wstart < 1000);
      wstart = t;
    },
    jump: (ms: number) => {
      call(ms);
      wstart = t;
    },
  };
}

// Something renders until a test says otherwise.
function make(opts: ConstructorParameters<typeof FrameRateMonitor>[0] = {}) {
  const clock = fakeRaf();
  const monitor = new FrameRateMonitor({ raf: clock.raf, caf: clock.caf, heartbeatMs: Infinity, ...opts });
  const state = { busy: true };
  monitor.load(() => state.busy);
  const seen: FrameWindow[] = [];
  monitor.onWindow((w) => seen.push(w));
  return { clock, monitor, state, seen };
}
const verdicts = (seen: FrameWindow[]) => seen.map((w) => (w.slow ? 'slow' : w.smooth ? 'smooth' : 'mid'));

describe('FrameRateMonitor windows', () => {
  // Continuous: every window counts, so the reading itself is what is under test.
  const continuous = { burstWindows: Infinity, agreeWindows: Infinity };

  it('ignores the first window of a burst and reports one per second after it', () => {
    const { clock, monitor, seen } = make(continuous);
    monitor.poke();
    expect(clock.running()).toBe(true);
    clock.first(100);
    clock.win(100);
    expect(seen).toHaveLength(0);
    clock.win(100);
    expect(seen).toHaveLength(1);
    expect(seen[0].fps).toBeLessThan(15);
    expect(seen[0]).toMatchObject({ slow: true, smooth: false });
  });

  it('calls a window slow under 40 fps, smooth over 55, and neither in between', () => {
    const { clock, monitor, seen } = make(continuous);
    monitor.poke();
    clock.first(16);
    clock.win(16);
    clock.win(16);
    clock.win(22); // ~45 fps
    clock.win(100);
    expect(verdicts(seen)).toEqual(['smooth', 'mid', 'slow']);
  });

  it('judges a 30 Hz display against its own rate, not as a slow page', () => {
    const { clock, monitor, seen } = make(continuous);
    monitor.poke();
    clock.first(1000 / 30);
    for (let i = 0; i < 4; i++) clock.steady(1000 / 30);
    expect(monitor.peak).toBeGreaterThan(25);
    expect(verdicts(seen)).toEqual(['smooth', 'smooth', 'smooth']);
    // Half its rate on that display is slow.
    clock.steady(1000 / 12);
    expect(verdicts(seen).at(-1)).toBe('slow');
  });

  it('drops the window that follows a stall (a hidden page), then measures again', () => {
    const { clock, monitor, seen } = make(continuous);
    monitor.poke();
    clock.first(16);
    clock.win(16);
    clock.win(16);
    expect(seen).toHaveLength(1);
    clock.jump(10000);
    clock.win(100); // dropped
    expect(seen).toHaveLength(1);
    clock.win(100);
    expect(verdicts(seen)).toEqual(['smooth', 'slow']);
  });
});

describe('FrameRateMonitor bursts', () => {
  it('does not start without anything rendering, and a poke stops it when that goes', () => {
    const { clock, monitor, state } = make();
    state.busy = false;
    monitor.poke();
    expect(clock.running()).toBe(false);
    state.busy = true;
    monitor.poke();
    expect(clock.running()).toBe(true);
    state.busy = false;
    monitor.poke();
    expect(clock.running()).toBe(false);
    expect(clock.caf).toHaveBeenCalled();
  });

  it('stops by itself once two windows in a row agree', () => {
    const { clock, monitor, seen } = make();
    monitor.poke();
    clock.first(16);
    clock.win(16); // dropped
    clock.win(16);
    expect(clock.running()).toBe(true);
    clock.win(16);
    expect(verdicts(seen)).toEqual(['smooth', 'smooth']);
    expect(monitor.running).toBe(false);
    expect(clock.running()).toBe(false);
  });

  it('keeps measuring while the windows disagree, and stops at BURST_WINDOWS', () => {
    const { clock, monitor, seen } = make();
    monitor.poke();
    clock.first(16);
    clock.win(16); // dropped
    clock.win(16);
    clock.win(100);
    clock.win(16);
    expect(monitor.running).toBe(true);
    clock.win(100);
    expect(verdicts(seen)).toEqual(['smooth', 'slow', 'smooth', 'slow']);
    expect(monitor.running).toBe(false);
  });

  it('is extended by a poke, which starts its count over', () => {
    const { clock, monitor, seen } = make();
    monitor.poke();
    clock.first(100);
    clock.win(100); // dropped
    clock.win(100);
    monitor.poke(); // something changed: the agreement so far does not end the burst
    clock.win(100);
    expect(monitor.running).toBe(true);
    clock.win(100);
    expect(seen).toHaveLength(3);
    expect(monitor.running).toBe(false);
  });

  it('a consumer that pokes from its window keeps the burst going', () => {
    const { clock, monitor, state } = make();
    let changes = 3;
    monitor.onWindow(() => {
      if (changes-- > 0) monitor.poke();
    });
    expect(state.busy).toBe(true);
    monitor.poke();
    clock.first(100);
    clock.win(100); // dropped
    for (let i = 0; i < 3; i++) clock.win(100);
    expect(monitor.running).toBe(true);
    clock.win(100);
    clock.win(100);
    expect(monitor.running).toBe(false);
  });

  it('starts afresh on the next event, telling consumers, and drops the first window again', () => {
    const { clock, monitor, seen } = make();
    const started = vi.fn();
    monitor.onStart(started);
    monitor.poke();
    clock.first(16);
    clock.win(16);
    clock.win(16);
    clock.win(16);
    expect(monitor.running).toBe(false);
    expect(started).toHaveBeenCalledTimes(1);
    monitor.poke();
    expect(started).toHaveBeenCalledTimes(2);
    clock.first(16);
    clock.win(16); // dropped
    expect(seen).toHaveLength(2);
    clock.win(16);
    expect(seen).toHaveLength(3);
  });

  it('does not run in a hidden tab, and measures from scratch when it is back', () => {
    const { clock, monitor, seen } = make();
    let state = 'visible';
    const get = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state as DocumentVisibilityState);
    try {
      monitor.poke();
      clock.first(100);
      state = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(clock.running()).toBe(false);
      state = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(clock.running()).toBe(true);
      clock.first(100);
      clock.win(100); // the first window again: dropped
      expect(seen).toHaveLength(0);
    } finally {
      get.mockRestore();
    }
  });

  it('stops for good on dispose', () => {
    const { clock, monitor } = make();
    monitor.poke();
    expect(clock.running()).toBe(true);
    monitor.dispose();
    expect(clock.running()).toBe(false);
    monitor.poke();
    expect(clock.running()).toBe(false);
  });

  describe('heartbeat', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('starts a burst every HEARTBEAT_MS while something renders, with no window dropped', () => {
      const { clock, monitor, seen } = make({ heartbeatMs: HEARTBEAT_MS });
      monitor.poke();
      clock.first(16);
      clock.win(16); // dropped
      clock.win(16);
      clock.win(16);
      expect(monitor.running).toBe(false);
      expect(seen).toHaveLength(2);
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(monitor.running).toBe(true);
      clock.first(16);
      clock.win(16); // nothing was mounting: this one counts
      expect(seen).toHaveLength(3);
    });

    it('goes quiet when nothing renders any more', () => {
      const { clock, monitor, state } = make({ heartbeatMs: HEARTBEAT_MS });
      monitor.poke();
      clock.first(16);
      clock.win(16);
      clock.win(16);
      state.busy = false;
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(monitor.running).toBe(false);
      vi.advanceTimersByTime(HEARTBEAT_MS * 3);
      expect(monitor.running).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears its timer on dispose', () => {
      const { monitor } = make({ heartbeatMs: HEARTBEAT_MS });
      monitor.poke();
      expect(vi.getTimerCount()).toBe(1);
      monitor.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
