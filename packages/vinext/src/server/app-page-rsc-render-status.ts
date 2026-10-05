import type { NavigationContext } from "vinext/shims/navigation";
import type { RootParams } from "vinext/shims/root-params";
import {
  resolveAppPageShellSpecialError,
  resolveAppPageSpecialErrorStoredHeaders,
} from "./app-page-execution.js";
import { isAppSsrRenderResult, type AppPageSsrHandler } from "./app-page-stream.js";

/**
 * The status of a finished RSC render, as Next.js's static generation decides
 * it from the document's shell. A special error that rejects the shell sets
 * it. One inside a Suspense boundary leaves the render a 200.
 */
export type AppPageRscRenderStatus =
  | { kind: "page" }
  | { kind: "special-error"; status: number; headers?: Record<string, string> }
  /** A render Next.js wouldn't store: another error rejected the shell, or generateMetadata()'s. */
  | { kind: "unstorable" };

type CreateAppPageRscRenderStatusResolverOptions = {
  basePath?: string;
  capturedRscData: Promise<ArrayBuffer>;
  getCapturedSpecialError: () => unknown;
  getCapturedSpecialErrors: (error: unknown) => readonly unknown[];
  isForceStatic: boolean;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  navigationContext: NavigationContext | null;
  rootParams?: RootParams;
};

const PAGE_STATUS: AppPageRscRenderStatus = { kind: "page" };

/**
 * Resolve an RSC-only render's status once its Flight payload is complete.
 * Flight can't tell whether a special error sits inside a Suspense boundary, so
 * a render that threw one renders the document's shell from the same payload,
 * as Next.js's static generation renders HTML beside RSC. Its server
 * components don't run again. A render without a special error is a 200.
 */
export function createAppPageRscRenderStatusResolver(
  options: CreateAppPageRscRenderStatusResolverOptions,
): () => Promise<AppPageRscRenderStatus> {
  let status: Promise<AppPageRscRenderStatus> | undefined;
  return () => (status ??= resolveAppPageRscRenderStatus(options));
}

async function resolveAppPageRscRenderStatus(
  options: CreateAppPageRscRenderStatusResolverOptions,
): Promise<AppPageRscRenderStatus> {
  const rscData = await options.capturedRscData;
  if (options.getCapturedSpecialError() === null) return PAGE_STATUS;

  const ssrHandler = await options.loadSsrHandler();
  let rendered: Awaited<ReturnType<AppPageSsrHandler["handleSsr"]>>;
  try {
    rendered = await ssrHandler.handleSsr(
      new Response(rscData).body!,
      options.navigationContext,
      { links: [], preloads: [], styles: [] },
      {
        basePath: options.basePath,
        isForceStatic: options.isForceStatic,
        isStaticGeneration: true,
        // The RSC render already reported its errors, and this document is
        // discarded.
        onSsrError: () => undefined,
        rootParams: options.rootParams,
      },
    );
  } catch (error) {
    const specialError = resolveAppPageShellSpecialError(
      error,
      options.getCapturedSpecialErrors(error),
    );
    if (!specialError || specialError.fromMetadata === true) return { kind: "unstorable" };
    const headers = resolveAppPageSpecialErrorStoredHeaders(specialError, options.basePath);
    return {
      kind: "special-error",
      status: specialError.statusCode,
      ...(headers ? { headers } : {}),
    };
  }
  const htmlStream = isAppSsrRenderResult(rendered) ? rendered.htmlStream : rendered;
  void htmlStream.cancel().catch(() => {});
  return PAGE_STATUS;
}

/**
 * The status Next.js sends an RSC request for a render with this status. Its
 * payload carries a redirect, so a redirect is a 200 with its `location`.
 */
export function resolveAppPageRscResponseStatus(status: number): number {
  return status >= 300 && status < 400 ? 200 : status;
}
