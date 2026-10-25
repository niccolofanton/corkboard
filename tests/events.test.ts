import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/events';

describe('Emitter', () => {
  it('delivers an event emitted by a listener after the one in hand has reached every listener', () => {
    const e = new Emitter<{ a: number; b: number }>();
    const log: string[] = [];
    e.on('a', (n) => {
      log.push(`first a${n}`);
      if (n === 1) e.emit('a', 2);
      if (n === 2) e.emit('b', 3);
    });
    e.on('a', (n) => log.push(`second a${n}`));
    e.on('b', (n) => log.push(`b${n}`));
    e.emit('a', 1);
    expect(log).toEqual(['first a1', 'second a1', 'first a2', 'second a2', 'b3']);
  });

  it('keeps going after a listener throws, and is not stuck afterwards', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = new Emitter<{ a: number }>();
    const log: number[] = [];
    e.on('a', (n) => {
      if (n === 1) {
        e.emit('a', 2);
        throw new Error('boom');
      }
    });
    e.on('a', (n) => log.push(n));
    e.emit('a', 1);
    e.emit('a', 3);
    expect(log).toEqual([1, 2, 3]);
    err.mockRestore();
  });
});
