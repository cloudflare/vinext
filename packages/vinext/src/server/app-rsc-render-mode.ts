export type AppRscRenderMode =
  | "navigation"
  | "prefetch-loading-shell"
  | "prefetch-runtime"
  | "prefetch-static"
  | "refresh-preserve-ui"
  | "action-rerender-preserve-ui";

export const APP_RSC_RENDER_MODE_NAVIGATION = "navigation" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL =
  "prefetch-loading-shell" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_RUNTIME = "prefetch-runtime" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_STATIC = "prefetch-static" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI =
  "refresh-preserve-ui" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_ACTION_RERENDER_PRESERVE_UI =
  "action-rerender-preserve-ui" satisfies AppRscRenderMode;

export function shouldSuppressLoadingBoundaries(mode: AppRscRenderMode): boolean {
  return (
    mode === APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI ||
    mode === APP_RSC_RENDER_MODE_ACTION_RERENDER_PRESERVE_UI
  );
}

function shouldUsePreserveUiCacheVariant(mode: AppRscRenderMode): boolean {
  return shouldSuppressLoadingBoundaries(mode);
}

export function getRscRenderModeCacheVariant(mode: AppRscRenderMode): string | null {
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL) {
    return "prefetch-loading-shell";
  }
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_RUNTIME) {
    return "prefetch-runtime";
  }
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_STATIC) {
    return "prefetch-static";
  }

  return shouldUsePreserveUiCacheVariant(mode) ? "preserve-ui" : null;
}

export function parseAppRscRenderMode(value: string | null): AppRscRenderMode {
  switch (value) {
    case APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL;
    case APP_RSC_RENDER_MODE_PREFETCH_RUNTIME:
      return APP_RSC_RENDER_MODE_PREFETCH_RUNTIME;
    case APP_RSC_RENDER_MODE_PREFETCH_STATIC:
      return APP_RSC_RENDER_MODE_PREFETCH_STATIC;
    case APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI:
      return APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI;
    case APP_RSC_RENDER_MODE_ACTION_RERENDER_PRESERVE_UI:
      return APP_RSC_RENDER_MODE_ACTION_RERENDER_PRESERVE_UI;
    case null:
    default:
      return APP_RSC_RENDER_MODE_NAVIGATION;
  }
}
