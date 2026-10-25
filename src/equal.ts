// Structural equality for the JSON-like values a card holds (`media`, `data`): used to keep the board's own
// object when an incoming value is equal to it, so a no-op load or replay is not reported as a change.
//
// Plain objects and arrays are compared by value, on own keys only (an own key holding `undefined` equals a
// missing key, as in JSON; `{}` and `{ constructor: 'x' }` differ); numbers by `===` (so 0 equals -0, which JSON
// cannot tell apart); anything else (a Date, a Map, a class instance, a function) by identity. A pair of objects
// that is met again while comparing counts as equal the second time (if it were not, the first visit has already
// answered `false`): a value that shares parts, or points back to itself, is compared in time linear in its
// distinct pairs, not in its paths. Past a nesting depth of 64 the answer is `false`, so a very deep `data`
// cannot overflow the stack.
const MAX_DEPTH = 64;
const hasOwn = Object.prototype.hasOwnProperty;

const isPlain = (o: object): boolean => {
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
};

type Seen = WeakMap<object, WeakSet<object>>;

export function deepEqual(a: unknown, b: unknown): boolean {
  return eq(a, b, 0, undefined);
}

// `seen` is made at the first pair of objects: comparing numbers and strings allocates nothing.
function eq(a: unknown, b: unknown, depth: number, seen: Seen | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return typeof a === 'number' && typeof b === 'number' && a !== a && b !== b;
  }
  if (depth > MAX_DEPTH) return false;
  const arrA = Array.isArray(a);
  if (arrA !== Array.isArray(b)) return false;
  if (!arrA && (!isPlain(a) || !isPlain(b))) return false;
  seen ??= new WeakMap();
  let peers = seen.get(a);
  if (peers === undefined) seen.set(a, (peers = new WeakSet()));
  if (peers.has(b)) return true;
  peers.add(b);
  if (arrA) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!eq(x[i], y[i], depth + 1, seen)) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of Object.keys(x)) {
    if (!eq(x[k], hasOwn.call(y, k) ? y[k] : undefined, depth + 1, seen)) return false;
  }
  for (const k of Object.keys(y)) if (!hasOwn.call(x, k) && y[k] !== undefined) return false;
  return true;
}
