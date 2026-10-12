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
});
