/** An event listener. */
export type Listener<T> = (payload: T) => void;

// A listener that throws must not stop the others, nor the library's own bookkeeping that runs next to it.
// The error is reported on the console, once per throw, and swallowed.
export function reportListenerError(what: string, err: unknown): void {
  console.error(`[corkboard] ${what} threw`, err);
}

/**
 * A tiny typed event emitter. A listener that throws is reported with `console.error` and does not stop the others.
 * An event emitted by a listener while another is being delivered waits until that one has reached every listener:
 * events are delivered one at a time, in the order they were emitted.
 */
export class Emitter<M extends object> {
  private readonly map = new Map<keyof M, Set<Listener<never>>>();
  private delivering = false;
  private readonly queue: { type: keyof M; payload: unknown }[] = [];

  on<K extends keyof M>(type: K, fn: Listener<M[K]>): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(type, fn);
  }

  off<K extends keyof M>(type: K, fn: Listener<M[K]>): void {
    this.map.get(type)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    if (this.delivering) {
      this.queue.push({ type, payload });
      return;
    }
    this.delivering = true;
    try {
      this.deliver(type, payload);
      // Listeners may emit while we deliver: the queue grows behind the event in hand.
      for (let i = 0; i < this.queue.length; i++) this.deliver(this.queue[i].type, this.queue[i].payload as M[keyof M]);
    } finally {
      this.queue.length = 0;
      this.delivering = false;
    }
  }

  private deliver<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<M[K]>)(payload);
      } catch (err) {
        reportListenerError(`"${String(type)}" listener`, err);
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.queue.length = 0;
  }
}
