// Intercepting route folder markers and how many segments each climbs.
export const APP_PAGE_INTERCEPTION_MARKER_TRAVERSALS = [
  { prefix: "(...)", levels: Number.POSITIVE_INFINITY },
  { prefix: "(..)(..)", levels: 2 },
  { prefix: "(..)", levels: 1 },
  { prefix: "(.)", levels: 0 },
] as const;
