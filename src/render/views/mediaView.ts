// A media card (image or video): a container holding the picture, one Sprite. The stage assigns its
// texture from the TextureManager, level by level. Cards stay plain sprites: corners and hairline are
// baked into the textures, so they batch with no mask or shader. A video card is drawn the same way (its
// poster is the picture); the playing <video> is a DOM overlay (src/video/*), not part of this view.
import { Container, Sprite, Texture } from 'pixi.js';
import { DEG, type WorldRect } from '../../interact/geometry';
import type { Element } from '../../types';
import type { BoardCard } from '../types';
import { parseHex } from '../theme';
import type { ElementView, ViewCtx } from './view';

export class MediaView implements ElementView {
  readonly variant = 'media' as const;
  readonly display = new Container();
  private readonly sprite: Sprite;
  el: Element | null = null;
  mark = 0;
  // The texture-manager side of this card (slot id, size, urls); owned by the stage.
  card: BoardCard | null = null;
  // The level whose texture the sprite shows now (-1: the placeholder).
  shown = -1;
  private rect: WorldRect = { x: 0, y: 0, w: 1, h: 1, rot: 0 };
  // The size `place` last wrote (NaN: a view fresh from the pool, which holds another card's).
  private placedW = Number.NaN;
  private placedH = Number.NaN;

  constructor() {
    this.sprite = new Sprite(Texture.WHITE);
    this.sprite.anchor.set(0.5);
    this.sprite.eventMode = 'none';
    this.display.eventMode = 'none';
    this.display.addChild(this.sprite);
  }

  get kind(): Element['kind'] {
    return this.el?.kind ?? 'image';
  }

  mount(el: Element, rect: WorldRect, ctx: ViewCtx): void {
    this.el = el;
    this.display.alpha = 1;
    this.rect = rect;
    this.place();
    this.paintPlaceholder(ctx);
  }

  update(el: Element, _props: readonly string[], rect: WorldRect, ctx: ViewCtx): void {
    this.el = el;
    this.rect = rect;
    this.place();
    if (this.shown < 0) this.paintPlaceholder(ctx);
  }

  setRect(r: WorldRect): void {
    this.rect = r;
    this.place();
  }

  refresh(ctx: ViewCtx): void {
    this.place();
    if (this.shown < 0) this.paintPlaceholder(ctx);
  }

  // The container sits at the box's centre and turns about it. A drag moves and turns it every frame and
  // leaves the size alone: only the position is written then.
  private place(): void {
    const r = this.rect;
    const d = this.display;
    if (r.w !== this.placedW || r.h !== this.placedH) {
      this.placedW = r.w;
      this.placedH = r.h;
      d.pivot.set(r.w / 2, r.h / 2);
      const s = this.sprite;
      s.position.set(r.w / 2, r.h / 2);
      s.width = r.w;
      s.height = r.h;
    }
    d.position.set(r.x + r.w / 2, r.y + r.h / 2);
    d.rotation = r.rot * DEG;
  }

  setAlphaOverride(alpha: number): void {
    this.display.alpha = alpha;
  }

  // Points the sprite at `tex` (null = placeholder). Returns whether anything changed.
  setTexture(tex: Texture | null, level: number, ctx: ViewCtx): boolean {
    const s = this.sprite;
    if (tex === null) {
      if (this.shown < 0 && s.texture === Texture.WHITE) return false;
      this.shown = -1;
      this.paintPlaceholder(ctx);
      return true;
    }
    if (s.texture === tex) {
      this.shown = level;
      return false;
    }
    const w = s.width;
    const h = s.height;
    s.texture = tex;
    s.tint = 0xffffff;
    // Assigning a texture resets the scale to the new texture's size: restore the card's size.
    s.width = w;
    s.height = h;
    this.shown = level;
    return true;
  }

  // A flat well: the media's own `color` when it has one, else the theme's.
  private paintPlaceholder(ctx: ViewCtx): void {
    const s = this.sprite;
    const w = s.width;
    const h = s.height;
    const color = this.el?.media.color;
    s.texture = Texture.WHITE;
    s.tint = (color !== undefined ? parseHex(color) : null) ?? ctx.theme.well;
    s.width = w;
    s.height = h;
    this.shown = -1;
  }

  unmount(): void {
    this.el = null;
    this.card = null;
    this.shown = -1;
    this.placedW = Number.NaN;
    this.placedH = Number.NaN;
  }
}
