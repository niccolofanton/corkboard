// TextureManager's worker bookkeeping against stub workers (no GL: the renderer is a stub, nothing is
// uploaded).
// Pixi probes a 2D canvas on import; jsdom has none and would print a not-implemented error.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextureManager, type WantedItem } from '../../src/render/textures';
import type { BoardCard } from '../../src/render/types';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: Array<{ op: string; rid: number }> = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: { op: string; rid: number }): void {
    this.sent.push(m);
  }
  terminate(): void {}
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const card = (id: number): BoardCard => ({
  id,
  w: 100,
  h: 100,
  thumbhash: undefined,
  l1Url: `https://x.test/${id}.jpg`,
  l2Url: undefined,
  l3Url: undefined,
  radius: 4,
});
const want = (...ids: number[]): WantedItem[] => ids.map((id) => ({ card: card(id), level: 1, dist: id }));

let tm: TextureManager;
beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  tm = new TextureManager({ texture: {}, gl: {} } as never, { budgetBytes: 1 << 30, workers: 1, onWake: () => {} });
});
afterEach(() => {
  tm.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const load = () => (tm as unknown as { workerLoad: number[] }).workerLoad;

describe('TextureManager worker load', () => {
  it('counts a request in and out', () => {
    tm.setWanted(want(1, 2));
    expect(load()).toEqual([2]);
    const [w] = FakeWorker.all;
    w.reply({ op: 'fail', rid: w.sent[0].rid, reason: 'x', aborted: false });
    expect(load()).toEqual([1]);
  });

  it('does not let replies to pre-reset requests eat into the new requests\' count', () => {
    tm.setWanted(want(1, 2));
    const [w] = FakeWorker.all;
    const stale = w.sent.map((m) => m.rid);
    tm.reset();
    expect(load()).toEqual([0]);
    tm.setWanted(want(3));
    expect(load()).toEqual([1]);
    // The workers answer the cancels sent by reset().
    for (const rid of stale) w.reply({ op: 'fail', rid, reason: 'aborted', aborted: true });
    expect(load()).toEqual([1]);
    // ... and the live one still balances to zero.
    const live = w.sent.filter((m) => m.op === 'load' && !stale.includes(m.rid))[0];
    w.reply({ op: 'fail', rid: live.rid, reason: 'x', aborted: false });
    expect(load()).toEqual([0]);
  });
});
