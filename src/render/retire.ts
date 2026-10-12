// Deferred teardown of GPU objects.
//
// Root cause of a "use after destroy" (`Cannot read properties of null (reading 'addressModeU')`
// from GlBatchAdaptor.execute): when a sprite swaps to a texture whose source is ALREADY in its batch (an
// atlas page, say), Pixi's `Batcher.checkAndUpdateTexture` just reuses that slot and does NOT rebuild the
// batch, so the batch keeps listing the old texture even though no sprite uses it any more. Destroying
// that texture later leaves a dead source in a live batch, and the next draw binds it.
//
// Two rules therefore: (1) nothing is destroyed inline: the teardown is parked here and runs only after
// `delay` completed renders, or when the loop goes idle after at least one render; (2) whenever something
// is parked, the stage forces Pixi to rebuild the world's instruction set (`onRetire`), so by the time
// the teardown runs no batch can still name the old texture.
export class RetireQueue {
  private items: { at: number; run: () => void }[] = [];
  private renders = 0;

  constructor(private readonly delay = 2) {}

  get size(): number {
    return this.items.length;
  }

  push(run: () => void): void {
    this.items.push({ at: this.renders, run });
  }

  // Call once per completed render.
  afterRender(): void {
    this.renders++;
    this.flush(this.delay);
  }

  // The loop parked: anything that survived one render is safe to tear down now.
  flushIdle(): void {
    this.flush(1);
  }

  // Everything, right now (dispose, tests).
  flushAll(): void {
    const run = this.items;
    this.items = [];
    for (const it of run) this.safely(it.run);
  }

  private flush(minRenders: number): void {
    if (this.items.length === 0) return;
    const keep: { at: number; run: () => void }[] = [];
    const run: (() => void)[] = [];
    for (const it of this.items) {
      if (this.renders - it.at >= minRenders) run.push(it.run);
      else keep.push(it);
    }
    this.items = keep;
    for (const f of run) this.safely(f);
  }

  // One failing teardown must not strand the others (a destroyed-twice texture, a lost context).
  private safely(f: () => void): void {
    try {
      f();
    } catch (e) {
      console.error('[corkboard] teardown failed', e);
    }
  }
}
