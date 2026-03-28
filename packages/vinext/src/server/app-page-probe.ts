import {
  probeAppPageComponent,
  probeAppPageLayouts,
  type AppPageSpecialError,
} from "./app-page-execution.js";

export interface ProbeAppPageBeforeRenderOptions {
  hasLoadingBoundary: boolean;
  layoutCount: number;
  probeLayoutAt: (layoutIndex: number) => unknown;
  probePage: () => unknown;
  renderLayoutSpecialError: (
    specialError: AppPageSpecialError,
    layoutIndex: number,
  ) => Promise<Response>;
  renderPageSpecialError: (specialError: AppPageSpecialError) => Promise<Response>;
  resolveSpecialError: (error: unknown) => AppPageSpecialError | null;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
}

export async function probeAppPageBeforeRender(
  options: ProbeAppPageBeforeRenderOptions,
): Promise<Response | null> {
  // Layouts render before their children in Next.js, so layout-level special
  // errors must be handled before probing the page component itself.
  if (options.layoutCount > 0) {
    const layoutProbeResponse = await probeAppPageLayouts({
      layoutCount: options.layoutCount,
      async onLayoutError(layoutError, layoutIndex) {
        const specialError = options.resolveSpecialError(layoutError);
        if (!specialError) {
          return null;
        }

        return options.renderLayoutSpecialError(specialError, layoutIndex);
      },
      probeLayoutAt: options.probeLayoutAt,
      runWithSuppressedHookWarning(probe) {
        return options.runWithSuppressedHookWarning(probe);
      },
    });

    if (layoutProbeResponse) {
      return layoutProbeResponse;
    }
  }

  // Server Components are functions, so we can probe the page ahead of stream
  // creation and only turn special throws into immediate responses.
  return probeAppPageComponent({
    awaitAsyncResult: !options.hasLoadingBoundary,
    async onError(pageError) {
      const specialError = options.resolveSpecialError(pageError);
      if (specialError) {
        return options.renderPageSpecialError(specialError);
      }

      // Non-special probe failures (for example use() outside React's render
      // cycle or client references executing on the server) are expected here.
      // The real RSC/SSR render path will surface those properly below.
      return null;
    },
    probePage: options.probePage,
    runWithSuppressedHookWarning(probe) {
      return options.runWithSuppressedHookWarning(probe);
    },
  });
}
