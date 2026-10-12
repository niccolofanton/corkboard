// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { attachVideoReveal, createRevealSpinner, injectRevealStyles } from '../../src/video/reveal';

const styles = (): number => document.head.querySelectorAll('style[data-corkboard-video]').length;

describe('reveal styles', () => {
  it('injects exactly one stylesheet, however often it is needed', () => {
    injectRevealStyles(document);
    injectRevealStyles(document);
    createRevealSpinner(document);
    const host = document.createElement('div');
    const v = document.createElement('video');
    host.append(v);
    attachVideoReveal(v).dispose();
    expect(styles()).toBe(1);
    expect(document.head.querySelector('style[data-corkboard-video]')?.textContent).toContain(
      '.cb-video',
    );
  });

  it('builds the ring as a disc holding a ring', () => {
    const disc = createRevealSpinner(document);
    expect(disc.className).toBe('cb-spinner');
    expect(disc.firstElementChild?.className).toBe('cb-ring');
  });
});
