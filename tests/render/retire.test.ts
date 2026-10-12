import { describe, expect, it, vi } from 'vitest';
import { RetireQueue } from '../../src/render/retire';

describe('RetireQueue', () => {
  it('never runs a teardown in the frame that parked it', () => {
    const q = new RetireQueue(2);
    const run = vi.fn();
    q.push(run);
    expect(run).not.toHaveBeenCalled();
    expect(q.size).toBe(1);
  });

  it('runs it only after `delay` completed renders', () => {
    const q = new RetireQueue(2);
    const run = vi.fn();
    q.push(run);
    q.afterRender();
    expect(run).not.toHaveBeenCalled();
    q.afterRender();
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.size).toBe(0);
  });

  it('counts renders from the moment each item was parked', () => {
    const q = new RetireQueue(2);
    const a = vi.fn();
    const b = vi.fn();
    q.push(a);
    q.afterRender();
    q.push(b);
    q.afterRender();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    q.afterRender();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('flushIdle runs what survived one render, not what was just parked', () => {
    const q = new RetireQueue(3);
    const old = vi.fn();
    const fresh = vi.fn();
    q.push(old);
    q.afterRender();
    q.push(fresh);
    q.flushIdle();
    expect(old).toHaveBeenCalledTimes(1);
    expect(fresh).not.toHaveBeenCalled();
  });

  it('flushAll runs everything now (dispose)', () => {
    const q = new RetireQueue(5);
    const fns = [vi.fn(), vi.fn(), vi.fn()];
    fns.forEach((f) => q.push(f));
    q.flushAll();
    for (const f of fns) expect(f).toHaveBeenCalledTimes(1);
    expect(q.size).toBe(0);
  });

  it('a throwing teardown does not strand the others parked in the same pass', () => {
    const q = new RetireQueue(1);
    const ok = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    q.push(() => {
      throw new Error('boom');
    });
    q.push(ok);
    q.afterRender();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    expect(q.size).toBe(0);
    err.mockRestore();
  });
});
