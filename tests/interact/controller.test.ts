// The Interaction layer's keyboard against a real Store and a stub stage: keys are the board's only when
// the board itself has focus, never when they bubble up from an input inside the host.
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The controller only needs GRID from the stage module; loading Pixi in jsdom is noise.
vi.mock('../../src/render/stage', () => ({ GRID: 24 }));
import { Interaction } from '../../src/interact/controller';
import { createElement } from '../../src/model';
import type { Stage } from '../../src/render/stage';
import { Store } from '../../src/store';

let host: HTMLElement;
let input: HTMLInputElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"><input id="field"></div>';
  host = document.getElementById('host') as HTMLElement;
  input = document.getElementById('field') as HTMLInputElement;
});

function make() {
  const store = new Store();
  const stage = {
    onFrame: () => () => {},
    requestFrame: () => {},
    overlay: { setSelection: () => {}, setHover: () => {}, setGuides: () => {}, setMarquee: () => {} },
    cam: { scale: 1 },
    fit: vi.fn(),
  } as unknown as Stage;
  const it_ = new Interaction(host, stage, store, { guides: false, grid: false } as never);
  const el = createElement({ x: 0, y: 0, w: 100, h: 100, media: { src: 'a.jpg' } }, 'a');
  store.add([el]);
  it_.setSelection(['a']);
  const key = (target: HTMLElement, init: KeyboardEventInit) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  return { store, it_, key, stage };
}

describe('Interaction keyboard', () => {
  it('Backspace / Delete on the host removes the selection', () => {
    const { store, key } = make();
    key(host, { key: 'Backspace' });
    expect(store.size).toBe(0);
  });

  it('ignores keys that bubble up from an input inside the host', () => {
    const { store, it_, key, stage } = make();
    expect(key(input, { key: 'Backspace' })).toBe(true); // not preventDefault-ed: typing still works
    key(input, { key: 'Delete' });
    key(input, { key: '0' });
    key(input, { key: 'a', metaKey: true });
    key(input, { key: 'Escape' });
    key(input, { key: ' ', code: 'Space' });
    expect(store.size).toBe(1);
    expect(it_.selection).toEqual(['a']);
    expect((stage.fit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
