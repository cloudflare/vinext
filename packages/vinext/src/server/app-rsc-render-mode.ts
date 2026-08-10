export type AppRscRenderMode =
  | "navigation"
  | "prefetch-empty"
  | "prefetch-dynamic-shell"
  | "prefetch-loading-shell"
  | "prefetch-reuse-page";

export const APP_RSC_RENDER_MODE_NAVIGATION = "navigation" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_EMPTY = "prefetch-empty" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL =
  "prefetch-dynamic-shell" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL =
  "prefetch-loading-shell" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_REUSE_PAGE =
  "prefetch-reuse-page" satisfies AppRscRenderMode;

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
  if (mode === APP_RSC_RENDER_MODE_PREFETCH_REUSE_PAGE) {
    return "prefetch-reuse-page";
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
    case APP_RSC_RENDER_MODE_PREFETCH_REUSE_PAGE:
      return APP_RSC_RENDER_MODE_PREFETCH_REUSE_PAGE;
    case null:
    default:
      return APP_RSC_RENDER_MODE_NAVIGATION;
  }
}
