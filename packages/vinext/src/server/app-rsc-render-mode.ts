export type AppRscRenderMode = "navigation" | "prefetch-dynamic-shell" | "prefetch-loading-shell";

export const APP_RSC_RENDER_MODE_NAVIGATION = "navigation" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL =
  "prefetch-dynamic-shell" satisfies AppRscRenderMode;
export const APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL =
  "prefetch-loading-shell" satisfies AppRscRenderMode;

export function getRscRenderModeCacheVariant(mode: AppRscRenderMode): string | null {
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
    case APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL;
    case APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL:
      return APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL;
    case null:
    default:
      return APP_RSC_RENDER_MODE_NAVIGATION;
  }
}
