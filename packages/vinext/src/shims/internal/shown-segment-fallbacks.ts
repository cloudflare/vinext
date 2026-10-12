// Segment boundaries currently rendering their fallback in place of children.
// The browser entry reads this, and it can load these boundaries through a
// separate module instance, so the set lives on a Symbol.for global.
const _SHOWN_SEGMENT_FALLBACKS_KEY = Symbol.for("vinext.shownSegmentFallbacks");

type ShownSegmentFallbacksGlobal = typeof globalThis & {
  [_SHOWN_SEGMENT_FALLBACKS_KEY]?: Set<object>;
};

function getShownSegmentFallbacks(): Set<object> {
  const globalState = globalThis as ShownSegmentFallbacksGlobal;
  globalState[_SHOWN_SEGMENT_FALLBACKS_KEY] ??= new Set();
  return globalState[_SHOWN_SEGMENT_FALLBACKS_KEY];
}

export function trackSegmentFallback(boundary: object, shown: boolean): void {
  if (shown) {
    getShownSegmentFallbacks().add(boundary);
  } else {
    getShownSegmentFallbacks().delete(boundary);
  }
}

/**
 * Whether an error, catchError, not-found, forbidden or unauthorized fallback is
 * on screen.
 */
export function isSegmentFallbackShown(): boolean {
  return getShownSegmentFallbacks().size > 0;
}
