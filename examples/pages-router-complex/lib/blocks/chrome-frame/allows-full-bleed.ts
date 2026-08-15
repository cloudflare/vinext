import { ViewKind } from "../../view/kind";

const FULL_BLEED_VIEW_KINDS = new Set<ViewKind>([
  ViewKind.GALLERY,
  ViewKind.LOOKUP,
  ViewKind.FRONT,
]);

export const allowsFullBleed = (viewKind: ViewKind | undefined): boolean =>
  !!viewKind && FULL_BLEED_VIEW_KINDS.has(viewKind);
