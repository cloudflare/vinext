export type AppRscRenderMode =
  | "cached-navigation-runtime-stage"
  | "cached-navigation-static-stage"
  | "navigation"
  | "prefetch-empty"
  | "prefetch-dynamic-shell"
  | "prefetch-loading-shell";

export const APP_RSC_RENDER_MODE_NAVIGATION = "navigation" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_CACHED_NAVIGATION_RUNTIME_STAGE =
  "cached-navigation-runtime-stage" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_CACHED_NAVIGATION_STATIC_STAGE =
  "cached-navigation-static-stage" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_EMPTY = "prefetch-empty" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL =
  "prefetch-dynamic-shell" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL =
  "prefetch-loading-shell" satisfies AppRscRenderMode;

export function getRscRenderModeCacheVariant(mode: AppRscRenderMode): string | null {
  if (mode === APP_RSC_RENDER_MODE_CACHED_NAVIGATION_RUNTIME_STAGE) {
    return "cached-navigation-runtime-stage";
  }
  if (mode === APP_RSC_RENDER_MODE_CACHED_NAVIGATION_STATIC_STAGE) {
    return "cached-navigation-static-stage";
  }
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_EMPTY) {
    return "prefetch-empty";
  }

  if (mode === APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL) {
    return "prefetch-dynamic-shell";
  }
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL) {
    return "prefetch-loading-shell";
  }

  return null;
}

export function parseAppRscRenderMode(value: string | null): AppRscRenderMode {
  switch (value) {
    case APP_RSC_RENDER_MODE_CACHED_NAVIGATION_RUNTIME_STAGE:
      return APP_RSC_RENDER_MODE_CACHED_NAVIGATION_RUNTIME_STAGE;
    case APP_RSC_RENDER_MODE_CACHED_NAVIGATION_STATIC_STAGE:
      return APP_RSC_RENDER_MODE_CACHED_NAVIGATION_STATIC_STAGE;
    case APP_RSC_RENDER_MODE_PREFETCH_EMPTY:
      return APP_RSC_RENDER_MODE_PREFETCH_EMPTY;
    case APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL;
    case APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL;
    case null:
    default:
      return APP_RSC_RENDER_MODE_NAVIGATION;
  }
}
