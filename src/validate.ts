// Checks on what the host passes to `add`, `update` and `loadSnapshot`, before anything is stored. One place
// (`checkMedia`, `checkFields`), so the entry points agree - a card `add` takes is a card `loadSnapshot` takes -
// and a bad value is named (card and field) instead of surfacing later as a NaN transform or an empty canvas.
import { invertChange } from './change';
import { bad, boolean, finite, isObject, nonNegative, positive, show } from './check';
import type { Change, Card, CardId, CardInit, CardKind, CardPatch, CardMediaInput } from './types';

const KINDS: readonly CardKind[] = ['image', 'video', 'embed'];

// Base64, standard or url-safe, padded or not (what the decode path reads): whatever passes must decode. `atob`
// refuses a padded string whose length is not a multiple of 4, and a single leftover sextet.
function checkThumbhash(where: string, v: unknown): void {
  if (v instanceof Uint8Array) return;
  let ok = false;
  if (typeof v === 'string' && /^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) {
    const bare = v.replace(/=+$/, '');
    ok = bare.length % 4 !== 1 && (bare.length === v.length || v.length % 4 === 0);
  }
  if (!ok) bad(where, 'media.thumbhash must be a base64 string or a Uint8Array');
}

function checkMedia(where: string, media: unknown): void {
  if (typeof media !== 'object' || media === null || Array.isArray(media)) {
    return bad(where, `media must be an object (got ${show(media)})`);
  }
  const m = media as CardMediaInput;
  if (m.aspect !== undefined) positive(where, 'media.aspect', m.aspect);
  if (m.thumbhash !== undefined) checkThumbhash(where, m.thumbhash);
  const e = m.embed;
  if (e === undefined) return;
  if (typeof e !== 'object' || e === null) return bad(where, 'media.embed must be an object');
  const hasUrl = e.url !== undefined;
  const hasHtml = e.html !== undefined;
  if (hasUrl === hasHtml) bad(where, 'media.embed needs exactly one of url / html');
  if (hasUrl && (typeof e.url !== 'string' || e.url === '')) bad(where, 'media.embed.url must be a non-empty string');
  if (hasHtml && (typeof e.html !== 'string' || e.html === '')) bad(where, 'media.embed.html must be a non-empty string');
}

// The fields `add`, `update` and `loadSnapshot` all take (each only when given).
function checkFields(where: string, o: Partial<CardInit>): void {
  if (o.kind !== undefined && !KINDS.includes(o.kind)) {
    bad(where, `kind must be one of ${KINDS.join(', ')} (got ${show(o.kind)})`);
  }
  if (o.x !== undefined) finite(where, 'x', o.x);
  if (o.y !== undefined) finite(where, 'y', o.y);
  if (o.rot !== undefined) finite(where, 'rot', o.rot);
  if (o.w !== undefined) positive(where, 'w', o.w);
  if (o.h !== undefined) positive(where, 'h', o.h);
  if (o.radius !== undefined) nonNegative(where, 'radius', o.radius);
  if (o.locked !== undefined) boolean(where, 'locked', o.locked);
  if (o.aspectLocked !== undefined) boolean(where, 'aspectLocked', o.aspectLocked);
}

// Every init of a batch, before any of them is stored. `exists` answers for the cards already on the board.
export function validateInits(inits: readonly CardInit[], exists: (id: CardId) => boolean): void {
  const seen = new Set<CardId>();
  inits.forEach((init, i) => {
    if (typeof init !== 'object' || init === null) return bad(`add: item ${i}`, 'must be an object');
    const id = init.id;
    if (id !== undefined && (typeof id !== 'string' || id === '')) {
      bad(`add: item ${i}`, `id must be a non-empty string (got ${show(id)})`);
    }
    const where = id !== undefined ? `add: item ${i} ("${id}")` : `add: item ${i}`;
    checkMedia(where, init.media);
    checkFields(where, init);
    if (id !== undefined) {
      if (exists(id)) bad(where, 'a card with this id already exists');
      if (seen.has(id)) bad(where, 'duplicate id in this batch');
      seen.add(id);
    }
  });
}

// The fields of a patch that were given (an `undefined` one means "leave it", as in `Store.update`).
export function validatePatch(id: CardId, patch: CardPatch): void {
  const where = `update ("${id}")`;
  if (typeof patch !== 'object' || patch === null) return bad(where, 'patch must be an object');
  if (patch.media !== undefined) checkMedia(where, patch.media);
  checkFields(where, patch);
}

// One card of a snapshot, as `getSnapshot` wrote it (or a hand-written one): the same checks as `add`, and
// since a snapshot carries positions, x / y / w / h are required. `kind` is not: it comes from `media`.
export function validateSnapshotElement(i: number, el: unknown, seen: Set<CardId>): void {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) {
    return bad(`loadSnapshot: element ${i}`, 'must be an object');
  }
  const o = el as Record<string, unknown> & Partial<CardInit>;
  const id = o.id;
  if (typeof id !== 'string' || id === '') {
    bad(`loadSnapshot: element ${i}`, `id must be a non-empty string (got ${show(id)})`);
  }
  const where = `loadSnapshot: element ${i} ("${id}")`;
  if (seen.has(id as string)) bad(where, 'duplicate id');
  seen.add(id as string);
  finite(where, 'x', o.x);
  finite(where, 'y', o.y);
  positive(where, 'w', o.w);
  positive(where, 'h', o.h);
  checkFields(where, o);
  checkMedia(where, o.media);
}

const FIELDS = ['x', 'y', 'w', 'h', 'rot', 'locked', 'media', 'radius', 'aspectLocked', 'data', 'kind'] as const;

// Every field of a whole card (a `Change` carries full cards, so none may be missing).
function checkWholeElement(where: string, el: unknown): void {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) return bad(where, 'must be an object');
  const o = el as Record<string, unknown> & Partial<Card>;
  if (typeof o.id !== 'string' || o.id === '') bad(where, `id must be a non-empty string (got ${show(o.id)})`);
  const at = `${where} ("${o.id}")`;
  if (o.kind === undefined) bad(at, `kind must be one of ${KINDS.join(', ')} (got undefined)`);
  for (const f of ['x', 'y', 'w', 'h', 'rot', 'radius', 'locked', 'aspectLocked'] as const) {
    if (o[f] === undefined) bad(at, `${f} is missing`);
  }
  checkFields(at, o as Partial<CardInit>);
  checkMedia(at, o.media);
}

const checkId = (where: string, label: string, id: unknown): void => {
  if (typeof id !== 'string' || id === '') bad(where, `${label} must be a non-empty string (got ${show(id)})`);
};

// The shape of a `Change` as given: enough for `invertChange` to run on it without a TypeError, and nothing
// about the values yet.
function checkChangeShape(where: string, o: Partial<Change>): void {
  for (const k of ['added', 'removed', 'updated'] as const) {
    if (!Array.isArray(o[k])) bad(where, `${k} must be an array`);
  }
  o.added?.forEach((el, i) => {
    if (!isObject(el)) bad(`${where}: added[${i}]`, 'must be an object');
  });
  o.removed?.forEach((el, i) => {
    if (!isObject(el)) bad(`${where}: removed[${i}]`, 'must be an object');
  });
  o.updated?.forEach((u, i) => {
    const at = `${where}: updated[${i}]`;
    if (!isObject(u)) return bad(at, 'must be an object');
    if (!isObject(u.el)) bad(at, 'el must be an object');
    if (!isObject(u.prev)) bad(at, 'prev must be an object');
    if (!Array.isArray(u.props)) bad(at, 'props must be an array');
  });
  if (o.order !== undefined) {
    const moved = (o.order as { moved?: unknown } | null)?.moved;
    if (!Array.isArray(moved)) bad(where, 'order.moved must be an array');
    (moved as unknown[]).forEach((m, i) => {
      const at = `${where}: order.moved[${i}]`;
      if (!isObject(m)) return bad(at, 'must be an object');
      checkId(at, 'id', m.id);
      for (const k of ['prevBelow', 'nextBelow']) {
        if (m[k] !== null && (typeof m[k] !== 'string' || m[k] === '')) bad(at, `${k} must be an id or null (got ${show(m[k])})`);
      }
    });
  }
}

// An id may appear once in a list, and an id cannot be both added and removed: a change is a net diff.
function checkUnique(where: string, label: string, ids: readonly unknown[]): Set<unknown> {
  const seen = new Set<unknown>();
  ids.forEach((id, i) => {
    if (seen.has(id)) bad(`${where}: ${label}[${i}]`, `duplicate id "${String(id)}"`);
    seen.add(id);
  });
  return seen;
}

/**
 * A `Change`, before `applyChange` touches the board: its shape and every value it would write. Throws 'invalid'
 * naming the entry, with nothing changed. `invert`: the change is applied inverted, so what is checked is the
 * inverse (the `removed` cards are written back whole, the `prev` of each `updated` entry is what lands).
 */
export function validateChange(c: unknown, invert = false): void {
  const where = 'applyChange';
  if (!isObject(c)) return bad(where, 'change must be an object');
  const o = c as Partial<Change>;
  checkChangeShape(where, o);
  // From here on `eff` is what will be written. The names in messages stay those of the change as given.
  const eff = invert ? invertChange(o as Change) : (o as Change);
  const addedLabel = invert ? 'removed' : 'added';
  const removedLabel = invert ? 'added' : 'removed';
  eff.added.forEach((el, i) => checkWholeElement(`${where}: ${addedLabel}[${i}]`, el));
  eff.removed.forEach((el, i) => checkId(`${where}: ${removedLabel}[${i}]`, 'id', (el as Partial<Card>).id));
  const addedIds = checkUnique(where, addedLabel, eff.added.map((el) => el.id));
  const removedIds = checkUnique(where, removedLabel, eff.removed.map((el) => el.id));
  for (const id of addedIds) {
    if (removedIds.has(id)) bad(where, `"${String(id)}" is both added and removed`);
  }
  eff.updated.forEach((u, i) => {
    const at = `${where}: updated[${i}]${invert ? ' (inverted: prev is written)' : ''}`;
    const el = u.el as Partial<Card>;
    checkId(at, invert ? 'prev.id' : 'el.id', el.id);
    const name = `${at} ("${el.id}")`;
    for (const p of u.props) {
      if (!(FIELDS as readonly string[]).includes(p)) bad(name, `unknown prop ${show(p)}`);
      if (p === 'data') continue;
      if (p === 'media') checkMedia(name, el.media);
      else if (el[p] === undefined) bad(name, `${p} is missing`);
      else checkFields(name, { [p]: el[p] });
    }
  });
  checkUnique(where, 'updated', eff.updated.map((u) => u.el.id));
}
