import type { ReactNode } from "react";
import type { NavigationContext } from "vinext/shims/navigation";
import type { RootParams } from "vinext/shims/root-params";
import { _consumeRequestScopedCacheLife } from "vinext/shims/cache-request-state";
import type { CacheControlMetadata } from "vinext/shims/cache-handler";
import { consumeDynamicUsage, consumeInvalidDynamicUsageError } from "vinext/shims/headers";
import { getCollectedFetchTags } from "vinext/shims/fetch-cache";
import {
  consumeAppPageRenderObservationState,
  createAppPageHtmlOutputScope,
  createAppPageRenderObservation,
  createAppPageRscOutputScope,
} from "./app-page-render-observation.js";
import {
  buildAppPageFontLinkHeader,
  teeAppPageRscStreamForCapture,
  type AppPageFontPreload,
} from "./app-page-execution.js";
import {
  buildAppPageLinkHeader,
  isAppSsrRenderResult,
  type AppPageSsrHandler,
} from "./app-page-stream.js";
import { readStreamAsText } from "../utils/text-stream.js";
import { buildAppPageTags } from "./implicit-tags.js";

type AppPageRenderableElement = ReactNode | Record<string, ReactNode>;
type AppPageCacheRoute = {
  pattern: string;
  routeSegments: readonly string[];
};

export type RenderAppPageCacheArtifactsOptions = {
  basePath?: string;
  captureRscData: boolean;
  cleanPathname: string;
  clientTraceMetadata?: readonly string[];
  element: AppPageRenderableElement;
  getFontLinks: () => string[];
  getFontPreloads: () => AppPageFontPreload[];
  getFontStyles: () => string[];
  getNavigationContext: () => NavigationContext | null;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  mountedSlotsHeader?: string | null;
  navigationParams: Record<string, unknown>;
  onError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown;
  reactMaxHeadersLength?: number;
  renderToReadableStream: (
    element: AppPageRenderableElement,
    options: { onError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown },
  ) => ReadableStream<Uint8Array>;
  rootParams?: RootParams;
  route: AppPageCacheRoute;
  waitForAllReady?: boolean;
};

export type RenderAppPageCacheArtifactsResult = {
  cacheControl?: CacheControlMetadata;
  html: string;
  htmlRenderObservation: ReturnType<typeof createAppPageRenderObservation>;
  linkHeader?: string;
  rscData?: ArrayBuffer;
  rscRenderObservation?: ReturnType<typeof createAppPageRenderObservation>;
  tags: string[];
};

/**
 * Render an App page element to HTML (and optionally its RSC payload) for cache
 * storage. Combines the RSC stream, SSR handler, observation consumption, and
 * cache-tag construction used by both normal ISR revalidation and PPR fallback
 * shell regeneration.
 */
export async function renderAppPageCacheArtifacts(
  options: RenderAppPageCacheArtifactsOptions,
): Promise<RenderAppPageCacheArtifactsResult> {
  const rscStream = options.renderToReadableStream(options.element, {
    onError: options.onError,
  });
  const rscCapture = teeAppPageRscStreamForCapture(rscStream, options.captureRscData);
  const capturedRscDataRef: { value: Promise<ArrayBuffer> | null } = { value: null };
  const fontPreloads = options.getFontPreloads();
  const ssrHandler = await options.loadSsrHandler();
  const htmlResult = await ssrHandler.handleSsr(
    rscCapture.ssrStream,
    options.getNavigationContext(),
    {
      links: options.getFontLinks(),
      styles: options.getFontStyles(),
      preloads: fontPreloads,
    },
    {
      basePath: options.basePath,
      clientTraceMetadata: options.clientTraceMetadata,
      reactMaxHeadersLength: options.reactMaxHeadersLength,
      rootParams: options.rootParams,
      waitForAllReady: options.waitForAllReady,
      ...(rscCapture.sideStream
        ? {
            sideStream: rscCapture.sideStream,
            capturedRscDataRef,
          }
        : {}),
    },
  );
  const htmlStream = isAppSsrRenderResult(htmlResult) ? htmlResult.htmlStream : htmlResult;
  const reactLinkHeader = isAppSsrRenderResult(htmlResult) ? htmlResult.linkHeader : undefined;
  const linkHeader = buildAppPageLinkHeader(
    reactLinkHeader,
    buildAppPageFontLinkHeader(fontPreloads),
    options.reactMaxHeadersLength,
  );
  const html = await readStreamAsText(htmlStream);

  let rscData: ArrayBuffer | undefined;
  if (options.captureRscData) {
    const capturedPromise = capturedRscDataRef.value;
    if (!capturedPromise) {
      throw new Error(
        "[vinext] Expected captured RSC data while rendering app page cache artifacts",
      );
    }
    rscData = await capturedPromise;
  }

  const cacheLife = _consumeRequestScopedCacheLife();
  const tags = buildAppPageTags(
    options.cleanPathname,
    getCollectedFetchTags(),
    options.route.routeSegments,
  );
  const observationState = consumeAppPageRenderObservationState();
  consumeInvalidDynamicUsageError();
  consumeDynamicUsage();

  const htmlRenderObservation = createAppPageRenderObservation({
    boundaryOutcome: { kind: "success" },
    cacheability: "public",
    cacheTags: tags,
    cleanPathname: options.cleanPathname,
    completeness: "complete",
    output: createAppPageHtmlOutputScope({
      element: options.element,
      renderEpoch: null,
      rootBoundaryId: null,
      routePattern: options.route.pattern,
    }),
    params: options.navigationParams,
    state: observationState,
  });

  const result: RenderAppPageCacheArtifactsResult = {
    html,
    htmlRenderObservation,
    ...(linkHeader ? { linkHeader } : {}),
    tags,
    cacheControl:
      typeof cacheLife?.revalidate === "number"
        ? { revalidate: cacheLife.revalidate, expire: cacheLife.expire }
        : undefined,
  };

  if (options.captureRscData) {
    result.rscData = rscData;
    result.rscRenderObservation = createAppPageRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: tags,
      cleanPathname: options.cleanPathname,
      completeness: "complete",
      output: createAppPageRscOutputScope({
        element: options.element,
        mountedSlotsHeader: options.mountedSlotsHeader,
        renderEpoch: null,
        rootBoundaryId: null,
        routePattern: options.route.pattern,
      }),
      params: options.navigationParams,
      state: observationState,
    });
  }

  return result;
}
