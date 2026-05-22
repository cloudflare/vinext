export type AppRscRenderMode =
  | "navigation"
  | "prefetch-loading-shell"
  | "refresh-preserve-ui"
  | "action-rerender-preserve-ui";

export const APP_RSC_RENDER_MODE_NAVIGATION = "navigation" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL =
  "prefetch-loading-shell" satisfies AppRscRenderMode;
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

  return shouldUsePreserveUiCacheVariant(mode) ? "preserve-ui" : null;
}

export function parseAppRscRenderMode(value: string | null): AppRscRenderMode {
  switch (value) {
    case APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL;
    case APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI:
      return APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI;
    case APP_RSC_RENDER_MODE_ACTION_RERENDER_PRESERVE_UI:
      return APP_RSC_RENDER_MODE_ACTION_RERENDER_PRESERVE_UI;
    case null:
    default:
      return APP_RSC_RENDER_MODE_NAVIGATION;
  }
}
