/**
 * Internal dynamic-route patterns, used verbatim as the `pathname` argument
 * of programmatic router navigations (with the matching params supplied in
 * `query` and the public URL passed as the `as` argument).
 */
export const InternalRoutePattern = {
  GALLERY: "/[zone]/gallery/[...facets]",
} as const;
