// The view registry: which pooled view class draws each element kind.
//
// Adding a kind means adding a `ViewDefinition` here (plus, when the kind needs live DOM, an overlay in
// the host: see `Overlay` in src/overlay.ts). The stage only knows the interface.
import type { CardKind } from '../../types';
import { MediaView } from './mediaView';
import type { CardView } from './view';

export interface ViewDefinition {
  // The pool name. Kinds that share a view class share a variant.
  variant: string;
  create(): CardView;
  // The view is a textured card: the stage allocates a texture slot for it and runs the LOD pipeline.
  textured: boolean;
}

export const VIEW_DEFINITIONS: Record<CardKind, ViewDefinition> = {
  image: { variant: 'media', create: () => new MediaView(), textured: true },
  video: { variant: 'media', create: () => new MediaView(), textured: true },
  // The poster of an embed is its texture; the live iframe is a DOM layer (src/embed/*).
  embed: { variant: 'media', create: () => new MediaView(), textured: true },
};
