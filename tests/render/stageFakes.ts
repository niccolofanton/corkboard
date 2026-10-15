// Fakes that let the real Stage run in jsdom. Pixi's Application (which needs WebGL) is replaced by a stub
// (`withFakeApplication`, for `vi.mock('pixi.js')`), and the browser pieces the stage leans on (rAF, a
// ResizeObserver, matchMedia, Workers, a 2D canvas context, the host's size) by hand-driven ones
// (`installDom`). Views, texture manager, camera and overlay are the real code.
import { vi } from 'vitest';
import type { Container } from 'pixi.js';

type Pixi = typeof import('pixi.js');

// What the stub renderer was asked to do.
export interface FakeApp {
  renders: number;
  initOptions: Record<string, unknown>;
  canvas: HTMLCanvasElement;
  stage: Container;
  resize: ReturnType<typeof vi.fn>;
  // texSubImage2D calls (atlas uploads), as argument lists.
  glUploads: unknown[][];
  destroyed: boolean;
}

export const fake: { app: FakeApp | null } = { app: null };

export function withFakeApplication(real: Pixi): Pixi {
  class FakeApplication implements FakeApp {
    renders = 0;
    initOptions: Record<string, unknown> = {};
    canvas = document.createElement('canvas');
    stage = new real.Container();
    ticker = { stop: () => {} };
    resize = vi.fn();
    glUploads: unknown[][] = [];
    destroyed = false;
    renderer = {
      resize: (w: number, h: number, dpr: number) => this.resize(w, h, dpr),
      background: { color: 0 },
      texture: {
        getGlSource: () => ({ target: 3553, texture: {} }),
        initSource: () => {},
        _activateLocation: () => {},
        _setBoundTexture: () => {},
        _premultiplyAlpha: true,
      },
      gl: {
        RENDERER: 7937,
        getExtension: () => null,
        getParameter: () => 'fake',
        RGBA: 6408,
        UNSIGNED_BYTE: 5121,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441,
        bindTexture: () => {},
        pixelStorei: () => {},
        generateMipmap: () => {},
        texSubImage2D: (...a: unknown[]) => this.glUploads.push(a),
      },
    };
    constructor() {
      fake.app = this;
    }
    async init(o: Record<string, unknown>): Promise<void> {
      this.initOptions = o;
    }
    render(): void {
      this.renders++;
    }
    destroy(_view?: unknown, options?: unknown): void {
      this.destroyed = true;
      this.stage.destroy(options as never);
    }
  }
  return { ...real, Application: FakeApplication } as unknown as Pixi;
}

export class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: { op: string; rid: number; level?: number; url?: string }[] = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: { op: string; rid: number }): void {
    this.sent.push(m);
  }
  terminate(): void {}
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  get loads(): { op: string; rid: number; level?: number; url?: string }[] {
    return this.sent.filter((m) => m.op === 'load');
  }
}

export interface FakeMq {
  query: string;
  listeners: Set<() => void>;
}

export interface Dom {
  host: HTMLElement;
  // rAF callbacks waiting to run.
  frames: FrameRequestCallback[];
  // Runs the oldest pending frame; returns false when there was none.
  runFrame(): boolean;
  // Runs frames until none is pending (at most `max`).
  drain(max?: number): number;
  size(w: number, h: number): void;
  observers: (() => void)[];
  // Fires the host's ResizeObserver callbacks.
  resizeHost(): void;
  mqs: FakeMq[];
  setDpr(dpr: number): void;
  restore(): void;
}

// Installs the browser fakes and returns the handles; call `restore()` when done.
export function installDom(w = 800, h = 600): Dom {
  FakeWorker.all = [];
  fake.app = null;
  const frames: FrameRequestCallback[] = [];
  let ts = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames.length = 0;
  });
  const observers: (() => void)[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe(): void {}
      disconnect(): void {
        observers.length = 0;
      }
    },
  );
  vi.stubGlobal('Worker', FakeWorker);
  const mqs: FakeMq[] = [];
  vi.stubGlobal('matchMedia', (query: string) => {
    const mq: FakeMq = { query, listeners: new Set() };
    mqs.push(mq);
    return {
      media: query,
      matches: true,
      addEventListener: (_t: string, l: () => void) => mq.listeners.add(l),
      removeEventListener: (_t: string, l: () => void) => mq.listeners.delete(l),
    };
  });
  // A 2D context for the stage's dot canvas (Pixi's own probes at import time ran against none).
  const proto = HTMLCanvasElement.prototype;
  const realGetContext = proto.getContext;
  const ctx2d = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => ((t[k] = v), true),
  });
  proto.getContext = ((type: string) => (type === '2d' ? ctx2d : null)) as never;
  const dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true, writable: true });

  const host = document.createElement('div');
  document.body.appendChild(host);
  let size = { w, h };
  host.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: size.w, bottom: size.h, width: size.w, height: size.h, x: 0, y: 0 }) as DOMRect;

  const dom: Dom = {
    host,
    frames,
    runFrame() {
      const cb = frames.shift();
      if (!cb) return false;
      ts += 16.7;
      cb(ts);
      return true;
    },
    drain(max = 50) {
      let n = 0;
      while (n < max && dom.runFrame()) n++;
      return n;
    },
    size(nw, nh) {
      size = { w: nw, h: nh };
    },
    observers,
    resizeHost() {
      for (const cb of [...observers]) cb();
    },
    mqs,
    setDpr(v) {
      (window as unknown as { devicePixelRatio: number }).devicePixelRatio = v;
    },
    restore() {
      proto.getContext = realGetContext;
      if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr);
      host.remove();
      vi.unstubAllGlobals();
    },
  };
  return dom;
}
