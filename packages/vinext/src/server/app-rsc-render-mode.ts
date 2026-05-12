export type AppRscRenderMode = "navigation" | "refresh-preserve-ui" | "action-rerender-preserve-ui";

export const APP_RSC_RENDER_MODE_NAVIGATION = "navigation" satisfies AppRscRenderMode;
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

export function shouldUsePreserveUiCacheVariant(mode: AppRscRenderMode): boolean {
  return shouldSuppressLoadingBoundaries(mode);
}

export function parseAppRscRenderMode(value: string | null): AppRscRenderMode {
  switch (value) {
    case APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI:
      return APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI;
    case APP_RSC_RENDER_MODE_ACTION_RERENDER_PRESERVE_UI:
      return APP_RSC_RENDER_MODE_ACTION_RERENDER_PRESERVE_UI;
    case null:
    default:
      return APP_RSC_RENDER_MODE_NAVIGATION;
  }
}
