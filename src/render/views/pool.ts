// Per-variant pools of element views: a view is expensive to build (Pixi objects) and cheap to reuse,
// and the viewport turns over hundreds of elements during a pan.
import type { ElementKind } from '../../types';
import { VIEW_DEFINITIONS, type ViewDefinition } from './registry';
import type { ElementView } from './view';

export class ViewPools {
  private readonly pools = new Map<string, ElementView[]>();
  private created = 0;
  private reused = 0;

  acquire(kind: ElementKind): ElementView {
    const def = VIEW_DEFINITIONS[kind];
    const v = this.pools.get(def.variant)?.pop();
    if (v) {
      this.reused++;
      return v;
    }
    this.created++;
    return def.create();
  }

  release(view: ElementView): void {
    let pool = this.pools.get(view.variant);
    if (!pool) {
      pool = [];
      this.pools.set(view.variant, pool);
    }
    pool.push(view);
  }

  stats(): { created: number; reused: number; pooled: number } {
    let pooled = 0;
    for (const p of this.pools.values()) pooled += p.length;
    return { created: this.created, reused: this.reused, pooled };
  }

  dispose(): void {
    this.pools.clear();
  }
}

export const definitionOf = (kind: ElementKind): ViewDefinition => VIEW_DEFINITIONS[kind];
