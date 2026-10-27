import type { CdnAppPageDocument } from "vinext/shims/cdn-cache";
import type { NavigationContext } from "vinext/shims/navigation";
import type { RootParams } from "vinext/shims/root-params";
import { isRenderDynamicLatched } from "vinext/shims/headers";
import {
  buildAppPageFontLinkHeader,
  resolveAppPageShellSpecialError,
  resolveAppPageSpecialErrorStoredHeaders,
} from "./app-page-execution.js";
import {
  buildAppPageLinkHeader,
  isAppSsrRenderResult,
  type AppPageFontData,
  type AppPageSsrHandler,
} from "./app-page-stream.js";
import type { InitialNavigationCacheMetadata } from "./app-ssr-stream.js";
import { readStreamAsText } from "../utils/text-stream.js";

/**
 * The status of a finished RSC render, as Next.js's static generation decides
 * it from the document's shell. A special error that rejects the shell sets
 * it. One inside a Suspense boundary leaves the render a 200.
 */
export type AppPageRscRenderStatus =
  | {
      kind: "page";
      /** The page's document, when the resolver rendered one to store. */
      document?: CdnAppPageDocument;
    }
  | { kind: "special-error"; status: number; headers?: Record<string, string> }
  /**
   * A render not stored: another error rejected the shell, or
   * generateMetadata()'s special error, whose document an RSC miss can't write.
   */
  | { kind: "unstorable" };

/** What the page's document renders with, as an HTML request renders it. */
type AppPageRscRenderDocumentOptions = {
  clientTraceMetadata?: readonly string[];
  /**
   * When the document's render is given up, as completed-response admission
   * gives up a body it hasn't captured by its deadline.
   */
  deadlineAt?: number;
  getFontData: () => AppPageFontData;
  getInitialNavigationCacheMetadata: () => InitialNavigationCacheMetadata;
  mirrorNextFlight: () => boolean;
  onSsrError: (error: unknown) => unknown;
  reactMaxHeadersLength?: number;
};

type CreateAppPageRscRenderStatusResolverOptions = {
  basePath?: string;
  capturedRscData: Promise<ArrayBuffer>;
  /**
   * Render the page's document from the payload, to be stored beside it.
   * Without it, only a render that threw a special error renders its shell.
   */
  document?: AppPageRscRenderDocumentOptions;
  getCapturedSpecialError: () => unknown;
  getCapturedSpecialErrors: (error: unknown) => readonly unknown[];
  isForceStatic: boolean;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  navigationContext: NavigationContext | null;
  rootParams?: RootParams;
  routePattern: string;
};

const PAGE_STATUS: AppPageRscRenderStatus = { kind: "page" };

/**
 * Resolve an RSC-only render's status once its Flight payload is complete.
 * Flight can't tell whether a special error sits inside a Suspense boundary, so
 * a render that threw one renders the document's shell from the same payload,
 * as Next.js's static generation renders HTML beside RSC. Its server
 * components don't run again. A render without a special error is a 200.
 *
 * With `document`, every render renders its document from the payload, as
 * Next.js keeps a page's document and RSC payload in one entry.
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
  const deadlineAt = options.document?.deadlineAt;
  if (deadlineAt === undefined) return renderAppPageRscRenderStatus(options);
  const expired = new AbortController();
  const remaining = deadlineAt - Date.now();
  const timer = remaining > 0 ? setTimeout(() => expired.abort(), remaining) : undefined;
  if (timer === undefined) expired.abort();
  try {
    const status = await unlessExpired(
      renderAppPageRscRenderStatus(options, expired.signal),
      expired.signal,
      () => {},
    );
    return status ?? expiredDocumentStatus(options);
  } finally {
    clearTimeout(timer);
  }
}

/** Settle with `promise`, or with `null` once `signal` aborts. */
function unlessExpired<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  discard: (value: T) => void,
): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.then(discard, () => {});
    return Promise.resolve(null);
  }
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => {
      void promise.then(discard, () => {});
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) discard(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Read the document, or cancel it and settle with `null` once `signal` aborts. */
async function readDocumentHtml(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  if (!signal) return readStreamAsText(stream);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const result = await unlessExpired(reader.read(), signal, () => {});
    if (result === null) {
      void reader.cancel().catch(() => {});
      return null;
    }
    if (result.done) break;
    chunks.push(decoder.decode(result.value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

/**
 * A document given up at its deadline isn't stored. A render without a
 * special error is still a 200, but one with a special error needs its shell.
 */
function expiredDocumentStatus(
  options: CreateAppPageRscRenderStatusResolverOptions,
): AppPageRscRenderStatus {
  return options.getCapturedSpecialError() === null ? PAGE_STATUS : { kind: "unstorable" };
}

async function renderAppPageRscRenderStatus(
  options: CreateAppPageRscRenderStatusResolverOptions,
  signal?: AbortSignal,
): Promise<AppPageRscRenderStatus> {
  const rscData = await options.capturedRscData;
  const documentOptions = options.document;
  if (!documentOptions && options.getCapturedSpecialError() === null) return PAGE_STATUS;

  const ssrHandler = await options.loadSsrHandler();
  if (signal?.aborted) return expiredDocumentStatus(options);
  const fontData = documentOptions?.getFontData() ?? { links: [], preloads: [], styles: [] };
  const clientTraceMetadataMarker =
    documentOptions?.clientTraceMetadata && documentOptions.clientTraceMetadata.length > 0
      ? crypto.randomUUID()
      : undefined;
  let rendered: Awaited<ReturnType<AppPageSsrHandler["handleSsr"]>> | null;
  try {
    rendered = await unlessExpired(
      ssrHandler.handleSsr(new Response(rscData).body!, options.navigationContext, fontData, {
        basePath: options.basePath,
        isForceStatic: options.isForceStatic,
        preloadRoutePattern: options.routePattern,
        rootParams: options.rootParams,
        ...(documentOptions
          ? {
              // The SSR options of an HTML request whose render may be stored.
              clientTraceMetadata: documentOptions.clientTraceMetadata,
              clientTraceMetadataMarker,
              getInitialNavigationCacheMetadata: documentOptions.getInitialNavigationCacheMetadata,
              isCacheCandidate: true,
              mirrorNextFlight: documentOptions.mirrorNextFlight,
              onSsrError: documentOptions.onSsrError,
              reactMaxHeadersLength: documentOptions.reactMaxHeadersLength,
              signal,
            }
          : {
              isStaticGeneration: true,
              // The RSC render already reported its errors, and this document
              // is discarded.
              onSsrError: () => undefined,
            }),
      }),
      signal,
      (late) => {
        void (isAppSsrRenderResult(late) ? late.htmlStream : late).cancel().catch(() => {});
      },
    );
  } catch (error) {
    const specialError = resolveAppPageShellSpecialError(
      error,
      options.getCapturedSpecialErrors(error),
    );
    // generateMetadata()'s special error rejects the shell only for a request
    // that blocks on metadata, as an html-limited bot does. Next.js stores the
    // document beside the payload, but an RSC miss writes no special error's
    // document, and a document request that streams metadata would store a 200
    // beside it.
    if (!specialError || specialError.fromMetadata === true) return { kind: "unstorable" };
    const headers = resolveAppPageSpecialErrorStoredHeaders(specialError, options.basePath);
    // A special error's own document renders as the request does, so an RSC
    // miss stores its payload alone and leaves the document to an HTML request.
    return {
      kind: "special-error",
      status: specialError.statusCode,
      ...(headers ? { headers } : {}),
    };
  }
  if (rendered === null) return expiredDocumentStatus(options);
  const htmlStream = isAppSsrRenderResult(rendered) ? rendered.htmlStream : rendered;
  if (!documentOptions) {
    void htmlStream.cancel().catch(() => {});
    return PAGE_STATUS;
  }
  let html: string | null;
  try {
    html = await readDocumentHtml(htmlStream, signal);
  } catch {
    // A document that fails after its shell isn't stored, as an HTML
    // request's isn't.
    return PAGE_STATUS;
  }
  if (html === null) return expiredDocumentStatus(options);
  // A client page that read its searchParams while the document rendered
  // makes the document dynamic, as it does an HTML request's.
  if (isRenderDynamicLatched()) return PAGE_STATUS;
  const linkHeader = buildAppPageLinkHeader(
    isAppSsrRenderResult(rendered) ? rendered.linkHeader : undefined,
    buildAppPageFontLinkHeader(fontData.preloads),
    documentOptions.reactMaxHeadersLength,
  );
  if (clientTraceMetadataMarker) {
    const { stripClientTraceMetadataBlock } = await import("./client-trace-metadata.js");
    html = stripClientTraceMetadataBlock(html, clientTraceMetadataMarker);
  }
  return { kind: "page", document: { html, ...(linkHeader ? { linkHeader } : {}) } };
}

/**
 * The status Next.js sends an RSC request for a render with this status. Its
 * payload carries a redirect, so a redirect is a 200 with its `location`.
 */
export function resolveAppPageRscResponseStatus(status: number): number {
  return status >= 300 && status < 400 ? 200 : status;
}
