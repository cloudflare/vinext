import React, { type ComponentType, type ReactNode } from "react";
import type { VinextNextData } from "../client/vinext-next-data.js";
import type { CachedPagesValue } from "vinext/shims/cache";
import { withScriptNonce } from "vinext/shims/script-nonce-context";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { buildRevalidateCacheControl } from "./cache-control.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { createInlineScriptTag, createNonceAttribute, escapeHtmlAttr } from "./html.js";
import { getClientTraceMetadataHTML } from "./client-trace-metadata.js";
import { reportRequestError } from "./instrumentation.js";
import { loadUserDocumentInitialProps } from "./pages-document-initial-props.js";
import { readStreamAsText } from "../utils/text-stream.js";
import { callDocumentGetInitialProps } from "./document-initial-head.js";

type PagesFontPreload = {
  href: string;
  type: string;
};

export type PagesI18nRenderContext = {
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
  domainLocales?: unknown;
};

export type PagesGsspResponse = {
  statusCode: number;
  getHeaders(): Record<string, string | number | boolean | string[]>;
};

type PagesStreamedHtmlResponse = {
  __vinextStreamedHtmlResponse?: boolean;
} & Response;

type RenderPagesPageResponseOptions = {
  assetTags: string;
  buildId: string | null;
  clearSsrContext: () => void;
  createPageElement: (pageProps: Record<string, unknown>) => ReactNode;
  DocumentComponent: ComponentType | null;
  flushPreloads?: (() => Promise<void> | void) | undefined;
  fontLinkHeader: string;
  fontPreloads: PagesFontPreload[];
  getFontLinks: () => string[];
  getFontStyles: () => string[];
  getSSRHeadHTML?: (() => string) | undefined;
  /**
   * Allow-list of OpenTelemetry propagation keys (from
   * `experimental.clientTraceMetadata`) to emit as `<meta>` tags in the SSR
   * head. Undefined or empty disables emission.
   */
  clientTraceMetadata?: readonly string[] | undefined;
  setDocumentInitialHead?: ((head: ReactNode[]) => void) | undefined;
  gsspRes: PagesGsspResponse | null;
  isrCacheKey: (router: string, pathname: string) => string;
  expireSeconds?: number;
  isrRevalidateSeconds: number | null;
  isrSet: (
    key: string,
    data: CachedPagesValue,
    revalidateSeconds: number,
    tags?: string[],
    expireSeconds?: number,
  ) => Promise<void>;
  i18n: PagesI18nRenderContext;
  /**
   * True when rendering a `getStaticPaths` fallback shell for a path that
   * isn't pre-rendered (`fallback: true` + unlisted path). Forwarded to
   * `buildPagesNextDataScript` so the client serialises `isFallback: true`
   * into `__NEXT_DATA__`, then later hydrates by fetching the data URL.
   */
  isFallback?: boolean;
  pageProps: Record<string, unknown>;
  params: Record<string, unknown>;
  renderDocumentToString: (element: ReactNode) => Promise<string>;
  renderToReadableStream: (element: ReactNode) => Promise<ReadableStream<Uint8Array>>;
  resetSSRHead?: (() => void) | undefined;
  routePattern: string;
  routeUrl: string;
  safeJsonStringify: (value: unknown) => string;
  scriptNonce?: string;
  statusCode?: number;
  vinext?: VinextNextData["__vinext"];
};

function buildPagesFontHeadHtml(
  fontLinks: string[],
  fontPreloads: PagesFontPreload[],
  fontStyles: string[],
  scriptNonce?: string,
): string {
  let html = "";
  const nonceAttr = createNonceAttribute(scriptNonce);

  for (const link of fontLinks) {
    html += `<link rel="stylesheet"${nonceAttr} href="${escapeHtmlAttr(link)}" />\n  `;
  }

  for (const preload of fontPreloads) {
    html += `<link rel="preload"${nonceAttr} href="${escapeHtmlAttr(preload.href)}" as="font" type="${escapeHtmlAttr(preload.type)}" crossorigin />\n  `;
  }

  if (fontStyles.length > 0) {
    html += `<style data-vinext-fonts${nonceAttr}>${fontStyles.join("\n")}</style>\n  `;
  }

  return html;
}

export function buildPagesNextDataScript(
  options: Pick<
    RenderPagesPageResponseOptions,
    | "buildId"
    | "i18n"
    | "isFallback"
    | "pageProps"
    | "params"
    | "routePattern"
    | "safeJsonStringify"
    | "scriptNonce"
  > & {
    vinext?: VinextNextData["__vinext"];
  },
): string {
  const nextDataPayload: Record<string, unknown> = {
    props: { pageProps: options.pageProps },
    page: options.routePattern,
    query: options.params,
    buildId: options.buildId,
    isFallback: options.isFallback === true,
  };

  if (options.i18n.locales) {
    nextDataPayload.locale = options.i18n.locale;
    nextDataPayload.locales = options.i18n.locales;
    nextDataPayload.defaultLocale = options.i18n.defaultLocale;
    nextDataPayload.domainLocales = options.i18n.domainLocales;
  }

  if (options.vinext) {
    nextDataPayload.__vinext = options.vinext;
  }

  const localeGlobals = options.i18n.locales
    ? `;window.__VINEXT_LOCALE__=${options.safeJsonStringify(options.i18n.locale)}` +
      `;window.__VINEXT_LOCALES__=${options.safeJsonStringify(options.i18n.locales)}` +
      `;window.__VINEXT_DEFAULT_LOCALE__=${options.safeJsonStringify(options.i18n.defaultLocale)}`
    : "";

  return createInlineScriptTag(
    `window.__NEXT_DATA__ = ${options.safeJsonStringify(nextDataPayload)}${localeGlobals}`,
    options.scriptNonce,
  );
}

async function buildPagesShellHtml(
  bodyMarker: string,
  fontHeadHTML: string,
  nextDataScript: string,
  options: Pick<
    RenderPagesPageResponseOptions,
    "assetTags" | "DocumentComponent" | "renderDocumentToString"
  > & {
    ssrHeadHTML: string;
  },
): Promise<string> {
  if (options.DocumentComponent) {
    const docProps = await loadUserDocumentInitialProps(options.DocumentComponent);
    const docElement = docProps
      ? React.createElement(options.DocumentComponent, docProps)
      : React.createElement(options.DocumentComponent);
    let html = await options.renderDocumentToString(docElement);
    html = html.replace("__NEXT_MAIN__", bodyMarker);
    if (options.ssrHeadHTML || options.assetTags || fontHeadHTML) {
      html = html.replace(
        "</head>",
        `  ${fontHeadHTML}${options.ssrHeadHTML}\n  ${options.assetTags}\n</head>`,
      );
    }
    html = html.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
    if (!html.includes("__NEXT_DATA__")) {
      html = html.replace("</body>", `  ${nextDataScript}\n</body>`);
    }
    return html;
  }

  // charset + viewport are emitted via getSSRHeadHTML() (next/head's
  // defaultHead seeds them with data-next-head=""), matching Next.js's
  // canonical ordering. Don't duplicate them here.
  return (
    "<!DOCTYPE html>\n<html>\n<head>\n" +
    `  ${fontHeadHTML}${options.ssrHeadHTML}\n` +
    `  ${options.assetTags}\n` +
    "</head>\n<body>\n" +
    `  <div id="__next">${bodyMarker}</div>\n` +
    `  ${nextDataScript}\n` +
    "</body>\n</html>"
  );
}

async function buildPagesCompositeStream(
  bodyStream: ReadableStream<Uint8Array>,
  shellPrefix: string,
  shellSuffix: string,
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(shellPrefix));
      const reader = bodyStream.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          controller.enqueue(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      controller.enqueue(encoder.encode(shellSuffix));
      controller.close();
    },
  });
}

async function reportPagesIsrCacheWriteError(
  error: unknown,
  cacheKey: string,
  routePattern: string,
): Promise<void> {
  console.error(`[vinext] Pages ISR cache write failed for ${cacheKey}:`, error);
  try {
    await reportRequestError(
      error instanceof Error ? error : new Error(String(error)),
      { path: cacheKey, method: "GET", headers: {} },
      {
        routerKind: "Pages Router",
        routePath: routePattern,
        routeType: "render",
      },
    );
  } catch {
    // Cache-write failure reporting must never make the background task reject.
  }
}

function schedulePagesIsrCacheWrite(options: {
  cacheKey: string;
  expireSeconds?: number;
  pageData: Record<string, unknown>;
  revalidateSeconds: number;
  routePattern: string;
  shellPrefix: string;
  shellSuffix: string;
  status: number;
  stream: ReadableStream<Uint8Array>;
  setCache: RenderPagesPageResponseOptions["isrSet"];
}): void {
  const cacheWritePromise = readStreamAsText(options.stream)
    .then((bodyHtml) =>
      options.setCache(
        options.cacheKey,
        {
          kind: "PAGES",
          html: options.shellPrefix + bodyHtml + options.shellSuffix,
          pageData: options.pageData,
          headers: undefined,
          status: options.status,
        },
        options.revalidateSeconds,
        undefined,
        options.expireSeconds,
      ),
    )
    .catch((error: unknown) =>
      reportPagesIsrCacheWriteError(error, options.cacheKey, options.routePattern),
    );

  getRequestExecutionContext()?.waitUntil(cacheWritePromise);
}

function applyGsspHeaders(
  headers: Headers,
  gsspRes: PagesGsspResponse | null,
  statusCode?: number,
): number {
  if (!gsspRes) {
    return statusCode ?? 200;
  }

  const gsspHeaders = gsspRes.getHeaders();
  for (const key of Object.keys(gsspHeaders)) {
    const value = gsspHeaders[key];
    const lowerKey = key.toLowerCase();
    if (lowerKey === "set-cookie" && Array.isArray(value)) {
      for (const cookie of value) {
        headers.append("set-cookie", String(cookie));
      }
      continue;
    }
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      headers.set(key, String(value));
    }
  }
  headers.set("Content-Type", "text/html");
  return statusCode ?? gsspRes.statusCode;
}

export async function renderPagesPageResponse(
  options: RenderPagesPageResponseOptions,
): Promise<Response> {
  const pageElement = withScriptNonce(
    React.createElement(React.Fragment, null, options.createPageElement(options.pageProps)),
    options.scriptNonce,
  );

  options.resetSSRHead?.();
  await options.flushPreloads?.();

  const fontHeadHTML = buildPagesFontHeadHtml(
    options.getFontLinks(),
    options.fontPreloads,
    options.getFontStyles(),
    options.scriptNonce,
  );
  const nextDataScript = buildPagesNextDataScript({
    buildId: options.buildId,
    i18n: options.i18n,
    isFallback: options.isFallback,
    pageProps: options.pageProps,
    params: options.params,
    routePattern: options.routePattern,
    safeJsonStringify: options.safeJsonStringify,
    scriptNonce: options.scriptNonce,
    vinext: options.vinext,
  });
  const bodyMarker = "<!--VINEXT_STREAM_BODY-->";
  // Render the page FIRST so that <Head> and other SSR state collectors
  // (e.g. styled-jsx, useServerInsertedHTML) are populated before we read
  // them. This fixes a race condition where head styles were silently dropped
  // because they were collected before the page had finished rendering.
  // Mirrors Next.js fix: vercel/next.js@9853944
  const bodyStream = await options.renderToReadableStream(pageElement);

  // If the user defined `_document.getInitialProps()`, run it now so any
  // head tags it returns can join the dedupe pipeline before getSSRHeadHTML
  // serialises the final <head>. Mirrors Next.js's `_document` contract.
  // The shared helper also skips the call when the resolved method is the
  // unmodified default from the shim — see comment in dev-server.ts.
  await callDocumentGetInitialProps(options.DocumentComponent, options.setDocumentInitialHead);

  const headFromShim = options.getSSRHeadHTML?.() ?? "";
  // Trace meta tags from the active OpenTelemetry context. When the
  // allow-list is unset (the common case) or OTel is not installed,
  // `getClientTraceMetadataHTML` returns "" and we forward the head HTML
  // verbatim — keeping the no-op path zero-overhead.
  const traceMetaHTML = getClientTraceMetadataHTML(options.clientTraceMetadata);
  const ssrHeadHTML = traceMetaHTML ? `${headFromShim}\n  ${traceMetaHTML}` : headFromShim;

  const shellHtml = await buildPagesShellHtml(bodyMarker, fontHeadHTML, nextDataScript, {
    assetTags: options.assetTags,
    DocumentComponent: options.DocumentComponent,
    renderDocumentToString: options.renderDocumentToString,
    ssrHeadHTML,
  });

  options.clearSsrContext();

  const markerIndex = shellHtml.indexOf(bodyMarker);
  const shellPrefix = shellHtml.slice(0, markerIndex);
  const shellSuffix = shellHtml.slice(markerIndex + bodyMarker.length);
  const responseHeaders = new Headers({ "Content-Type": "text/html" });
  const finalStatus = applyGsspHeaders(responseHeaders, options.gsspRes, options.statusCode);

  let responseBodyStream = bodyStream;
  if (
    // Keep nonce-bearing pages out of ISR writes: rewritePagesCachedHtml()
    // later matches the cached __NEXT_DATA__ block via a bare <script> marker.
    !options.scriptNonce &&
    options.isrRevalidateSeconds !== null &&
    options.isrRevalidateSeconds > 0
  ) {
    const cacheBodyStreamPair = bodyStream.tee();
    responseBodyStream = cacheBodyStreamPair[0];
    const cacheBodyStream = cacheBodyStreamPair[1];
    const isrPathname = options.routeUrl.split("?")[0];
    const cacheKey = options.isrCacheKey("pages", isrPathname);

    schedulePagesIsrCacheWrite({
      cacheKey,
      expireSeconds: options.expireSeconds,
      pageData: options.pageProps,
      revalidateSeconds: options.isrRevalidateSeconds,
      routePattern: options.routePattern,
      setCache: options.isrSet,
      shellPrefix,
      shellSuffix,
      status: finalStatus,
      stream: cacheBodyStream,
    });
  }

  const compositeStream = await buildPagesCompositeStream(
    responseBodyStream,
    shellPrefix,
    shellSuffix,
  );

  // Capture user-set Cache-Control (from getServerSideProps's res.setHeader)
  // so a downstream user override survives the gssp default below, and only
  // the default, never ISR/nonce Cache-Control which the runtime owns. Matches
  // Next.js's pages-handler.ts: `if (!res.getHeader('Cache-Control'))`.
  // responseHeaders/finalStatus are declared above so finalStatus can also feed
  // the ISR cache write; applyGsspHeaders is the only Cache-Control writer before
  // this point, so the captured value matches main's original capture site.
  const userSetCacheControl = responseHeaders.has("Cache-Control");

  if (options.scriptNonce) {
    responseHeaders.set("Cache-Control", "no-store, must-revalidate");
  } else if (options.isrRevalidateSeconds) {
    responseHeaders.set(
      "Cache-Control",
      buildRevalidateCacheControl(options.isrRevalidateSeconds, options.expireSeconds),
    );
    setCacheStateHeaders(responseHeaders, "MISS");
  } else if (options.gsspRes && !userSetCacheControl) {
    // Default for getServerSideProps responses, matching Next.js
    // pages-handler.ts (revalidate: 0 → getCacheControlHeader). Without this,
    // CDNs and browsers could cache per-request gssp responses.
    responseHeaders.set("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate");
  }
  if (options.fontLinkHeader) {
    responseHeaders.set("Link", options.fontLinkHeader);
  }

  const response: PagesStreamedHtmlResponse = Object.assign(
    new Response(compositeStream, {
      status: finalStatus,
      headers: responseHeaders,
    }),
    {
      __vinextStreamedHtmlResponse: true,
    },
  );
  // Mark the normal streamed HTML render so the Node prod server can strip
  // stale Content-Length only for this path, not for custom gSSP responses.
  return response;
}
