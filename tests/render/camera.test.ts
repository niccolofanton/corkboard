import { describe, expect, it } from 'vitest';
import { CameraController, MAX_SCALE, MIN_SCALE } from '../../src/render/camera';

function make(): { cam: CameraController; wakes: () => number } {
  let wakes = 0;
  const cam = new CameraController(() => wakes++);
  cam.setViewport(1280, 800);
  return { cam, wakes: () => wakes };
}

const drain = (cam: CameraController, maxFrames = 600): number => {
  let n = 0;
  while (cam.step(1000 / 60) && n < maxFrames) n++;
  return n;
};

describe('CameraController', () => {
  it('pans on a plain wheel and wakes the loop', () => {
    const { cam, wakes } = make();
    cam.wheel({ x: 10, y: 10, deltaX: 30, deltaY: -20, deltaMode: 0, zoom: false });
    expect(cam.cam.tx).toBe(-30);
    expect(cam.cam.ty).toBe(20);
    expect(wakes()).toBe(1);
  });

  it('zooms about the cursor: the world point under it does not move', () => {
    const { cam } = make();
    const ax = 400;
    const ay = 300;
    const wx0 = (ax - cam.cam.tx) / cam.cam.scale;
    const wy0 = (ay - cam.cam.ty) / cam.cam.scale;
    for (let i = 0; i < 30; i++) {
      cam.wheel({ x: ax, y: ay, deltaX: 0, deltaY: -6, deltaMode: 0, zoom: true });
      cam.step(8);
    }
    drain(cam);
    expect(cam.cam.scale).toBeGreaterThan(1.5);
    expect((ax - cam.cam.tx) / cam.cam.scale).toBeCloseTo(wx0, 3);
    expect((ay - cam.cam.ty) / cam.cam.scale).toBeCloseTo(wy0, 3);
  });

  it('clamps the zoom to 5 %..400 %', () => {
    const { cam } = make();
    for (let i = 0; i < 400; i++)
      cam.wheel({ x: 0, y: 0, deltaX: 0, deltaY: -20, deltaMode: 0, zoom: true });
    drain(cam);
    expect(cam.cam.scale).toBeCloseTo(MAX_SCALE, 2);
    for (let i = 0; i < 800; i++)
      cam.wheel({ x: 0, y: 0, deltaX: 0, deltaY: 20, deltaMode: 0, zoom: true });
    drain(cam);
    expect(cam.cam.scale).toBeCloseTo(MIN_SCALE, 3);
  });

  it('takes its zoom range from the bounds it is given', () => {
    const cam = new CameraController(() => {}, { min: 0.02, max: 2 });
    cam.setViewport(1280, 800);
    expect(cam.minScale).toBe(0.02);
    expect(cam.maxScale).toBe(2);
    for (let i = 0; i < 1200; i++)
      cam.wheel({ x: 0, y: 0, deltaX: 0, deltaY: 20, deltaMode: 0, zoom: true });
    drain(cam);
    expect(cam.cam.scale).toBeCloseTo(0.02, 3);
    // A board 50 000 px wide fits whole under the lower minimum (it would not at 0.05).
    const fit = cam.fitCamera({ x0: 0, y0: 0, x1: 50000, y1: 3000 }, 48);
    expect(fit.scale).toBeLessThan(0.05);
    expect(fit.scale).toBeGreaterThanOrEqual(0.02);
  });

  it('glides after a flick and then parks (busy goes false)', () => {
    const { cam } = make();
    cam.dragStart(100, 100, 0);
    cam.dragMove(140, 100, 16);
    cam.dragMove(180, 100, 32);
    cam.dragEnd(40);
    const x0 = cam.cam.tx;
    const frames = drain(cam);
    expect(cam.cam.tx).toBeGreaterThan(x0);
    expect(frames).toBeGreaterThan(5);
    expect(cam.busy).toBe(false);
  });

  it('is frame-rate independent: 60 Hz and 120 Hz glide to the same place', () => {
    const run = (dt: number): number => {
      const { cam } = make();
      cam.dragStart(0, 0, 0);
      cam.dragMove(50, 0, 16);
      cam.dragEnd(20);
      for (let i = 0; i < 2000 && cam.step(dt); i++);
      return cam.cam.tx;
    };
    const a = run(1000 / 60);
    const b = run(1000 / 120);
    expect(Math.abs(a - b) / Math.abs(a)).toBeLessThan(0.05);
  });

  it('fits a world rect with padding, centred', () => {
    const { cam } = make();
    const c = cam.fitCamera({ x0: 0, y0: 0, x1: 9000, y1: 9000 }, 48);
    expect(c.scale).toBeCloseTo((800 - 96) / 9000, 5);
    expect(c.tx + 4500 * c.scale).toBeCloseTo(640, 3);
    expect(c.ty + 4500 * c.scale).toBeCloseTo(400, 3);
  });

  it('flies to a camera and ends exactly on it', () => {
    const { cam } = make();
    const target = { tx: -500, ty: -300, scale: 0.5 };
    cam.flyTo(target, 300);
    drain(cam);
    expect(cam.cam.scale).toBeCloseTo(0.5, 6);
    expect(cam.cam.tx).toBeCloseTo(-500, 3);
    expect(cam.cam.ty).toBeCloseTo(-300, 3);
  });

  describe('a zoom clamped by the range', () => {
    // A camera that puts world point (100, 50) at the viewport centre, at a scale past the maximum.
    const centred = (scale: number) => ({
      scale,
      tx: 1280 / 2 - 100 * scale,
      ty: 800 / 2 - 50 * scale,
    });
    const centreOf = (cam: CameraController) => ({
      x: (1280 / 2 - cam.cam.tx) / cam.cam.scale,
      y: (800 / 2 - cam.cam.ty) / cam.cam.scale,
    });

    it('jumpTo keeps the world point at the viewport centre there', () => {
      const { cam } = make();
      cam.jumpTo(centred(10));
      expect(cam.cam.scale).toBe(MAX_SCALE);
      expect(centreOf(cam).x).toBeCloseTo(100, 6);
      expect(centreOf(cam).y).toBeCloseTo(50, 6);
    });

    it('flyTo lands with the world point at the viewport centre', () => {
      const { cam } = make();
      cam.flyTo(centred(10), 300);
      drain(cam);
      expect(cam.cam.scale).toBeCloseTo(MAX_SCALE, 6);
      expect(centreOf(cam).x).toBeCloseTo(100, 4);
      expect(centreOf(cam).y).toBeCloseTo(50, 4);
    });

    it('does the same below the minimum, and leaves an in-range camera alone', () => {
      const { cam } = make();
      cam.jumpTo(centred(0.001));
      expect(cam.cam.scale).toBe(MIN_SCALE);
      expect(centreOf(cam).x).toBeCloseTo(100, 6);
      const ok = { tx: -40, ty: 25, scale: 1.5 };
      cam.jumpTo(ok);
      expect(cam.cam).toEqual(ok);
    });
  });

  describe('a fit with nothing to fit', () => {
    it('leaves the camera where it is (a null target), animated or not', () => {
      const { cam, wakes } = make();
      cam.jumpTo({ tx: 12, ty: 34, scale: 2 });
      const before = { ...cam.cam };
      const w = wakes();
      cam.requestFit(() => null, 48, false);
      cam.requestFit(() => null, 48, true);
      expect(cam.cam).toEqual(before);
      expect(cam.busy).toBe(false);
      expect(wakes()).toBe(w);
    });

    it('also when it was asked for while the host had no size', () => {
      const cam = new CameraController(() => {});
      cam.setViewport(1, 1, true);
      cam.requestFit(() => null, 0);
      cam.setViewport(800, 600);
      expect(cam.cam).toEqual({ tx: 0, ty: 0, scale: 1 });
    });
  });

  describe('a fit asked for while the host has no size', () => {
    const world = { x0: 0, y0: 0, x1: 1000, y1: 500 };
    const empty = () => {
      const cam = new CameraController(() => {});
      cam.setViewport(1, 1, true);
      return cam;
    };

    it('does not compute a 1 px fit, and applies it at the first real size, centred', () => {
      const cam = empty();
      cam.requestFit(() => world, 50, true);
      expect(cam.cam).toEqual({ tx: 0, ty: 0, scale: 1 });
      expect(cam.busy).toBe(false);
      cam.setViewport(1200, 700);
      // 1100 x 600 available: scale 1.1, the 1000 x 500 world centred.
      expect(cam.cam.scale).toBeCloseTo(1.1, 6);
      expect(cam.cam.tx).toBeCloseTo((1200 - 1000 * 1.1) / 2, 6);
      expect(cam.cam.ty).toBeCloseTo((700 - 500 * 1.1) / 2, 6);
      expect(cam.busy).toBe(false); // jumped, not flown
    });

    it('reads the target when it is applied, and keeps waiting while one axis is still 0', () => {
      const cam = empty();
      let rect = world;
      cam.requestFit(() => rect, 0);
      cam.setViewport(800, 1, true);
      expect(cam.cam.scale).toBe(1);
      rect = { x0: 0, y0: 0, x1: 400, y1: 200 };
      cam.setViewport(800, 400);
      expect(cam.cam.scale).toBeCloseTo(2, 6);
    });

    it('is dropped when the user moved the camera meanwhile', () => {
      const cam = empty();
      cam.requestFit(() => world, 0);
      cam.panBy(30, 10);
      cam.setViewport(1000, 500);
      expect(cam.cam).toEqual({ tx: 30, ty: 10, scale: 1 });
    });

    it('is dropped by a later explicit camera move, and applies once only', () => {
      const cam = empty();
      cam.requestFit(() => world, 0);
      cam.jumpTo({ tx: 5, ty: 6, scale: 2 });
      cam.setViewport(1000, 500);
      expect(cam.cam).toEqual({ tx: 5, ty: 6, scale: 2 });

      const again = empty();
      again.requestFit(() => world, 0);
      again.setViewport(1000, 500);
      again.jumpTo({ tx: 0, ty: 0, scale: 3 });
      again.setViewport(500, 500);
      expect(again.cam.scale).toBe(3);
    });

    it('fits at once when the host has a size', () => {
      const { cam } = make();
      cam.requestFit(() => world, 0, false);
      expect(cam.cam.scale).toBeCloseTo(1.28, 6);
    });
  });
});
