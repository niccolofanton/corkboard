// The <style> elements the library injects into a document, shared by every board on it and removed with the
// last one. A reference count per document and sheet: the first user creates the element, the last one to let
// go removes it. A sheet that is already in the document and not ours (another copy of the library, a page
// that pre-declared it) is used as it is and never removed.

interface Sheet {
  // CSS selector that finds the element in the document.
  selector: string;
  // Marks the element it creates, so `selector` finds it.
  mark(el: HTMLStyleElement): void;
  css: string;
}

interface Entry {
  count: number;
  // The element we created (null: it was there already, so it is not ours to remove).
  own: HTMLStyleElement | null;
}

const registry = new WeakMap<Document, Map<string, Entry>>();

/**
 * Makes sure `sheet` is in the document's <head> and returns the function that lets go of it (idempotent).
 * `nonce` is set on the element it creates, for a CSP with a nonce-based `style-src`.
 */
export function acquireStyle(doc: Document, sheet: Sheet, nonce?: string): () => void {
  let perDoc = registry.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    registry.set(doc, perDoc);
  }
  const map = perDoc;
  let entry = map.get(sheet.selector);
  if (!entry) {
    entry = { count: 0, own: null };
    map.set(sheet.selector, entry);
  }
  const e = entry;
  // The element may have been removed from under us (a page that rewrites its <head>): make it again.
  const present = e.own ? e.own.isConnected : doc.head?.querySelector(sheet.selector) != null;
  if (!present && doc.head) {
    const style = doc.createElement('style');
    sheet.mark(style);
    if (nonce) style.nonce = nonce;
    style.textContent = sheet.css;
    doc.head.appendChild(style);
    e.own = style;
  }
  e.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--e.count > 0) return;
    e.own?.remove();
    map.delete(sheet.selector);
  };
}
