// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { acquireStyle } from '../src/styles';

const sheet = {
  selector: 'style[data-test-sheet]',
  mark: (el: HTMLStyleElement): void => el.setAttribute('data-test-sheet', ''),
  css: '.x{color:red}',
};
const found = (): HTMLStyleElement[] => [...document.head.querySelectorAll<HTMLStyleElement>(sheet.selector)];

afterEach(() => {
  document.head.innerHTML = '';
});

describe('acquireStyle', () => {
  it('creates one element for any number of users, with the nonce, and removes it with the last', () => {
    const r1 = acquireStyle(document, sheet, 'n0nce');
    const r2 = acquireStyle(document, sheet, 'n0nce');
    expect(found()).toHaveLength(1);
    expect(found()[0].nonce).toBe('n0nce');
    expect(found()[0].textContent).toBe(sheet.css);
    r1();
    r1(); // idempotent: does not release r2's reference
    expect(found()).toHaveLength(1);
    r2();
    expect(found()).toHaveLength(0);
  });

  it('makes the element again after a release, and when the page dropped it', () => {
    acquireStyle(document, sheet)();
    expect(found()).toHaveLength(0);
    const r = acquireStyle(document, sheet);
    found()[0].remove();
    const r2 = acquireStyle(document, sheet);
    expect(found()).toHaveLength(1);
    r();
    r2();
    expect(found()).toHaveLength(0);
  });

  it('uses a sheet it did not create and never removes it', () => {
    const own = document.createElement('style');
    sheet.mark(own);
    document.head.appendChild(own);
    const r = acquireStyle(document, sheet);
    expect(found()).toHaveLength(1);
    r();
    expect(found()).toHaveLength(1);
  });
});
