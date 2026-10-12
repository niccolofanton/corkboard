// Pixi's system ticker (its GC scheduler) would keep a requestAnimationFrame loop alive forever, so a board
// parks it. It is a global shared with the host app (and with other boards): remember how it was before the
// first board parked it and put it back when the last one lets go.

export interface TickerLike {
  autoStart: boolean;
  readonly started: boolean;
  start(): void;
  stop(): void;
}

interface Hold {
  count: number;
  autoStart: boolean;
  started: boolean;
}
const holds = new WeakMap<TickerLike, Hold>();

// Parks `ticker` (no auto start, stopped). Returns the release: idempotent, and the last one restores the
// state the ticker had before the first park.
export function parkTicker(ticker: TickerLike): () => void {
  let hold = holds.get(ticker);
  if (!hold) {
    hold = { count: 0, autoStart: ticker.autoStart, started: ticker.started };
    holds.set(ticker, hold);
  }
  hold.count++;
  ticker.autoStart = false;
  ticker.stop();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const h = holds.get(ticker);
    if (!h || --h.count > 0) return;
    holds.delete(ticker);
    ticker.autoStart = h.autoStart;
    if (h.started) ticker.start();
  };
}
