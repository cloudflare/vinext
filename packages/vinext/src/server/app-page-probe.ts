import {
  probeAppPageComponent,
  probeAppPageLayouts,
  type AppPageSpecialError,
  type LayoutClassificationOptions,
  type LayoutFlags,
} from "./app-page-execution.js";

export type ProbeAppPageBeforeRenderResult = {
  response: Response | null;
  layoutFlags: LayoutFlags;
};

export type ProbeAppPageBeforeRenderOptions = {
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
  /** When provided, enables per-layout static/dynamic classification. */
  classification?: LayoutClassificationOptions | null;
};

export async function probeAppPageBeforeRender(
  options: ProbeAppPageBeforeRenderOptions,
): Promise<ProbeAppPageBeforeRenderResult> {
  let layoutFlags: LayoutFlags = {};

  // Layouts render before their children in Next.js, so layout-level special
  // errors must be handled before probing the page component itself.
  if (options.layoutCount > 0) {
    const layoutProbeResult = await probeAppPageLayouts({
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
      classification: options.classification,
    });

    layoutFlags = layoutProbeResult.layoutFlags;

    if (layoutProbeResult.response) {
      return { response: layoutProbeResult.response, layoutFlags };
    }
  }

  // Server Components are functions, so we can probe the page ahead of stream
  // creation and only turn special throws into immediate responses.
  const pageResponse = await probeAppPageComponent({
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

  return { response: pageResponse, layoutFlags };
}
