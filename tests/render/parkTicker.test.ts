import { describe, expect, it } from 'vitest';
import { parkTicker } from '../../src/render/parkTicker';

function fake(autoStart: boolean, started: boolean) {
  const t = {
    autoStart,
    started,
    starts: 0,
    start() {
      t.started = true;
      t.starts++;
    },
    stop() {
      t.started = false;
    },
  };
  return t;
}

describe('parkTicker', () => {
  it('parks the ticker and restores a running, auto-starting one on release', () => {
    const t = fake(true, true);
    const release = parkTicker(t);
    expect([t.autoStart, t.started]).toEqual([false, false]);
    release();
    expect([t.autoStart, t.started]).toEqual([true, true]);
  });

  it('leaves a ticker that was stopped, stopped', () => {
    const t = fake(false, false);
    parkTicker(t)();
    expect([t.autoStart, t.started, t.starts]).toEqual([false, false, 0]);
  });

  it('restores only when the last of several boards lets go, to the state before the first', () => {
    const t = fake(true, true);
    const a = parkTicker(t);
    const b = parkTicker(t);
    a();
    expect(t.started).toBe(false);
    a(); // idempotent
    expect(t.started).toBe(false);
    b();
    expect([t.autoStart, t.started]).toEqual([true, true]);
    // A later board starts a new cycle from the then-current state.
    t.autoStart = false;
    t.started = false;
    parkTicker(t)();
    expect([t.autoStart, t.started]).toEqual([false, false]);
  });
});
