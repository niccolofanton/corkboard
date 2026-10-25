// Errors the board throws and reports.
import type { CardId } from './types';

/** Why a {@link CorkboardError} was thrown. */
export type CorkboardErrorCode =
  /** A method was called after `dispose()`. */
  | 'disposed'
  /** The browser cannot run the board (no WebGL2, or Pixi picked another renderer). */
  | 'unsupported'
  /**
   * A call or an option got a value it cannot use: `add` / `update` / `loadSnapshot` / `applyChange` a card value
   * (NaN, a size <= 0, a duplicate id...), or any method an id list of the wrong type, a NaN or out-of-range
   * number, an unknown enum value or a bad option. Nothing was changed.
   */
  | 'invalid';

/** The one error class the board throws: `instanceof CorkboardError`, then branch on `code`. */
export class CorkboardError extends Error {
  /** Why it was thrown; branch on this. */
  readonly code: CorkboardErrorCode;

  constructor(code: CorkboardErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CorkboardError';
    this.code = code;
  }
}

/**
 * A failure at runtime that did not throw: a picture that did not decode, a worker that died, a video or an
 * embed that failed. Reported through the board's `error` event; the card falls back to its placeholder.
 */
export interface BoardErrorEvent {
  /** What failed. */
  kind: 'texture' | 'worker' | 'video' | 'embed' | 'context';
  /** The card it concerns, if any. */
  id?: CardId;
  /** The URL that failed, if any. */
  url?: string;
  /** The underlying error (an Error, a DOM event, or a message). */
  cause: unknown;
}
