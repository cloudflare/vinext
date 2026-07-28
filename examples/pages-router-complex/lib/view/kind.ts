export enum ViewKind {
  /** Single-asset focus view */
  DETAIL = "detail",
  /** Filterable wall of assets */
  GALLERY = "gallery",
  /** Term-lookup results view */
  LOOKUP = "lookup",
  /** Front door */
  FRONT = "front",
  /** Long-form journal story */
  STORY = "story",
  /** Physical venue view */
  VENUE = "venue",
  /** Anything else */
  PLAIN = "plain",
}

/** Client-side fallback used when a page did not lift an explicit view kind. */
export const guessViewKind = (): ViewKind => {
  if (typeof window === "undefined") {
    return ViewKind.PLAIN;
  }
  const path = window.location.pathname;
  if (/\/view\//.test(path)) return ViewKind.DETAIL;
  if (/\/gallery\//.test(path)) return ViewKind.GALLERY;
  if (/\/lookup/.test(path)) return ViewKind.LOOKUP;
  return ViewKind.PLAIN;
};
