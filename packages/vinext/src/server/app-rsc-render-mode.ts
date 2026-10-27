export type AppRscRenderMode =
  | "navigation"
  | "prefetch-empty"
  | "prefetch-dynamic-shell"
  | "prefetch-loading-shell"
  | "prefetch-static-shell";

export const APP_RSC_RENDER_MODE_NAVIGATION = "navigation" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_EMPTY = "prefetch-empty" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL =
  "prefetch-dynamic-shell" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL =
  "prefetch-loading-shell" satisfies AppRscRenderMode;
/**
 * A Cache Components route's static shell: the page prerendered as Next.js
 * prefetches it, with its dynamic parts left at their Suspense fallbacks.
 */
export const APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL =
  "prefetch-static-shell" satisfies AppRscRenderMode;

/**
 * Marks a static-shell prefetch response: `partial` when the shell left some of
 * the page to its Suspense fallbacks, `complete` when it holds the whole page,
 * and `runtime` when the page's runtime prefetch rendered it for the request.
 */
export const VINEXT_STATIC_SHELL_HEADER = "X-Vinext-Static-Shell";
/**
 * The route params a static shell or runtime prefetch read, `?` for search
 * params, as a JSON array. A client reuses the payload for another URL of the
 * route with the same values for them, as Next.js's `varyParams` does.
 */
export const VINEXT_VARY_PARAMS_HEADER = "X-Vinext-Vary-Params";

export function getRscRenderModeCacheVariant(mode: AppRscRenderMode): string | null {
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_EMPTY) {
    return "prefetch-empty";
  }

  if (mode === APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL) {
    return "prefetch-dynamic-shell";
  }
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL) {
    return "prefetch-loading-shell";
  }
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL) {
    return "prefetch-static-shell";
  }

  return null;
}

export function parseAppRscRenderMode(value: string | null): AppRscRenderMode {
  switch (value) {
    case APP_RSC_RENDER_MODE_PREFETCH_EMPTY:
      return APP_RSC_RENDER_MODE_PREFETCH_EMPTY;
    case APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL;
    case APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL;
    case APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_STATIC_SHELL;
    case null:
    default:
      return APP_RSC_RENDER_MODE_NAVIGATION;
  }
}
