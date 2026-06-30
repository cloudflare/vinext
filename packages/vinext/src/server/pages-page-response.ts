import React, { type ComponentType, type ReactNode } from "react";
import type { VinextNextData } from "../client/vinext-next-data.js";
import type { CachedPagesValue } from "vinext/shims/cache-handler";
import { withScriptNonce } from "vinext/shims/script-nonce-context";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { applyCdnResponseHeaders } from "./cache-control.js";
import {
  buildMissIsrCacheControl,
  ISR_NEVER_CACHE_CONTROL,
  ISR_NO_STORE_CACHE_CONTROL,
} from "./isr-decision.js";
import { encodeCacheTag } from "../utils/encode-cache-tag.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { createNonceAttribute, escapeHtmlAttr } from "./html.js";
import { getClientTraceMetadataHTML } from "./client-trace-metadata.js";
import { reportRequestError } from "./instrumentation.js";
import {
  loadUserDocumentInitialProps,
  type RenderPageEnhancers,
  runDocumentRenderPage,
} from "./pages-document-initial-props.js";
import { fnv1a52 } from "../utils/hash.js";
import { readStreamAsText } from "../utils/text-stream.js";
import { callDocumentGetInitialProps } from "./document-initial-head.js";
import { appendAssetDeploymentIdQuery } from "../utils/deployment-id.js";

// ---------------------------------------------------------------------------
// Bot / crawler detection for Pages Router edge-runtime SSR
//
// Mirrors Next.js's packages/next/src/shared/lib/router/utils/html-bots.ts
// and is-bot.ts. These bots cannot parse streamed HTML correctly (they may
// read metadata only from the initial <head> flush), so we buffer the full
// response and emit it in a single chunk, identical to the Node.js path.
// ---------------------------------------------------------------------------

/**
 * Crawlers that cannot handle streamed HTML: they read metadata only from
 * the first network chunk, so streaming would give them an incomplete <head>.
 * Pattern sourced from Next.js html-bots.ts (updated to match the canary).
 */
const HTML_LIMITED_BOT_UA_RE =
  /[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i;

/**
 * Googlebot (the main search crawler) executes JavaScript via a headless
 * browser, so it too cannot safely handle mid-stream HTML mutations.
 * Matches "Googlebot" but NOT suffixed variants like "Googlebot-Image".
 */
const HEADLESS_BROWSER_BOT_UA_RE = /Googlebot(?!-)|Googlebot$/i;

/**
 * Returns true when the User-Agent belongs to a bot or crawler that cannot
 * reliably consume a streamed HTML response.
 */
export function isPagesStreamingBot(userAgent: string): boolean {
  return HEADLESS_BROWSER_BOT_UA_RE.test(userAgent) || HTML_LIMITED_BOT_UA_RE.test(userAgent);
}

// ---------------------------------------------------------------------------
// ETag generation — FNV-1a 52-bit, matching Next.js's generateETag() in
// packages/next/src/server/lib/etag.ts. Both produce a strong ETag (no W/
// prefix) when weak=false, which is the default Next.js uses at runtime.
// ---------------------------------------------------------------------------

export function generatePagesETag(payload: string): string {
  return '"' + fnv1a52(payload).toString(36) + payload.length.toString(36) + '"';
}

/**
 * Mirrors Next.js `sendEtagResponse` semantics (weak/strong comparison).
 *
 * A weak ETag `W/"..."` matches both `W/"..."` and `"..."` in `If-None-Match`.
 * A strong ETag `"..."` only matches the same strong token.
 * `*` always matches.
 */
export function etagMatches(etag: string, ifNoneMatch: string): boolean {
  if (ifNoneMatch === "*") return true;
  // Normalise: strip the W/ prefix for comparison. Next.js's
  // `sendEtagResponse` (packages/next/src/server/send-payload.ts) uses the
  // `fresh` package, which treats a weak token in `If-None-Match` as matching
  // the corresponding strong ETag and vice versa (RFC 7232 §2.3.2 weak
  // comparison). We replicate that behaviour here.
  const normalize = (t: string) => t.replace(/^W\//, "");
  const etagNorm = normalize(etag.trim());
  for (const token of ifNoneMatch.split(",")) {
    if (normalize(token.trim()) === etagNorm) return true;
  }
  return false;
}

/**
 * Returns true when a request `Cache-Control` header asks to bypass the 304
 * short-circuit. Mirrors the `fresh` package's check used by Next.js's
 * `sendEtagResponse` (`/(?:^|,)\s*?no-cache\s*?(?:,|$)/`). Shared by the
 * fresh-MISS bot path here and the ISR HIT/STALE paths in
 * `pages-page-data.ts` so the two cannot drift.
 */
export function requestsNoCache(cacheControl: string | undefined): boolean {
  return /(?:^|,)\s*no-cache\s*(?:,|$)/.test(cacheControl ?? "");
}

type PagesFontPreload = {
  href: string;
  type: string;
};

/**
 * The `__NEXT_DATA__` fields beyond the always-present core that the Pages
 * renderer serializes: the `__vinext` block plus the readiness flags
 * (gssp/gsp/gip/appGip/autoExport/isExperimentalCompile) the client uses to
 * recompute the initial `router.isReady`. Shared by every render path
 * (initial, ISR regeneration) so they emit identical readiness state.
 */
export type PagesNextDataExtras = Pick<
  VinextNextData,
  "__vinext" | "appGip" | "autoExport" | "gip" | "gsp" | "gssp" | "isExperimentalCompile"
>;

export type PagesI18nRenderContext = {
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
  domainLocales?: unknown;
};

export type PagesGsspResponse = {
  headersSent?: boolean;
  statusCode: number;
  getHeaders(): Record<string, string | number | boolean | string[]>;
};

type PagesDocumentReqRes = {
  req: unknown;
  res: PagesGsspResponse;
  responsePromise?: Promise<Response>;
};

type PagesStreamedHtmlResponse = {
  __vinextStreamedHtmlResponse?: boolean;
} & Response;

type RenderPagesPageResponseOptions = {
  assetTags: string;
  buildId: string | null;
  clearSsrContext: () => void;
  createPageElement: (pageProps: Record<string, unknown>) => ReactNode;
  /**
   * Build the page React tree with optional App/Component enhancers applied,
   * supporting the Pages Router `_document.getInitialProps` contract:
   *
   *   ctx.renderPage({ enhanceApp, enhanceComponent })
   *
   * Used by CSS-in-JS libraries (styled-components, emotion) to wrap the
   * App/Component tree so styles can be collected during SSR. When omitted,
   * `renderPage` falls back to rendering the plain `createPageElement` tree
   * (enhancers are ignored).
   */
  enhancePageElement?: ((opts: RenderPageEnhancers) => ReactNode) | undefined;
  DocumentComponent: ComponentType | null;
  err?: Error;
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
  documentReqRes?: PagesDocumentReqRes | null;
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
  props?: Record<string, unknown>;
  params: Record<string, unknown>;
  query?: Record<string, unknown>;
  renderDocumentToString: (element: ReactNode) => Promise<string>;
  renderToReadableStream: (element: ReactNode) => Promise<ReadableStream<Uint8Array>>;
  resetSSRHead?: (() => void) | undefined;
  routePattern: string;
  routeUrl: string;
  safeJsonStringify: (value: unknown) => string;
  scriptNonce?: string;
  statusCode?: number;
  vinext?: VinextNextData["__vinext"];
  nextData?: PagesNextDataExtras;
  /**
   * The request's User-Agent string (from `request.headers.get('user-agent')`).
   * When this matches a known crawler / bot pattern, the response is fully
   * buffered before sending so bots receive a single complete HTML chunk with
   * an ETag header. Omitting this field disables bot-detection (streaming as
   * normal), which is the correct behaviour for non-HTML requests and tests.
   */
  userAgent?: string;
  /**
   * The incoming request's `If-None-Match` header value. When set and the
   * computed ETag matches (weak-ETag semantics, mirroring Next.js's
   * `sendEtagResponse`), a `304 Not Modified` is returned with an empty body.
   * Only evaluated on bot/buffered responses that carry an ETag.
   */
  ifNoneMatch?: string;
  /**
   * The incoming request's `Cache-Control` header value. When the value
   * contains `no-cache`, the 304 short-circuit is skipped and a full 200
   * response is always returned — mirroring the `fresh` package used by
   * Next.js's `sendEtagResponse`.
   */
  requestCacheControl?: string;
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
    html += `<link rel="stylesheet"${nonceAttr} href="${escapeHtmlAttr(appendAssetDeploymentIdQuery(link))}" />\n  `;
  }

  for (const preload of fontPreloads) {
    html += `<link rel="preload"${nonceAttr} href="${escapeHtmlAttr(appendAssetDeploymentIdQuery(preload.href))}" as="font" type="${escapeHtmlAttr(preload.type)}" crossorigin />\n  `;
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
    | "props"
    | "params"
    | "routePattern"
    | "safeJsonStringify"
    | "scriptNonce"
    | "nextData"
  > & {
    vinext?: VinextNextData["__vinext"];
  },
): string {
  const nextDataPayload: Record<string, unknown> = {
    props: options.props ?? { pageProps: options.pageProps },
    page: options.routePattern,
    query: options.params,
    buildId: options.buildId,
    isFallback: options.isFallback === true,
  };

  if (options.nextData) {
    for (const [key, value] of Object.entries(options.nextData)) {
      if (value !== undefined) {
        nextDataPayload[key] = value;
      }
    }
  }

  if (options.i18n.locales) {
    nextDataPayload.locale = options.i18n.locale;
    nextDataPayload.locales = options.i18n.locales;
    nextDataPayload.defaultLocale = options.i18n.defaultLocale;
    nextDataPayload.domainLocales = options.i18n.domainLocales;
  }

  if (options.vinext) {
    nextDataPayload.__vinext = {
      ...options.nextData?.__vinext,
      ...options.vinext,
    };
  }

  return `<script id="__NEXT_DATA__" type="application/json"${createNonceAttribute(options.scriptNonce)}>${options.safeJsonStringify(nextDataPayload)}</script>`;
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
    /**
     * Document props already resolved by `runDocumentRenderPage`. When set,
     * `getInitialProps` was consumed by the renderPage path and must not be
     * re-invoked via `loadUserDocumentInitialProps` (which would call it a
     * second time). `null` means use the normal fast path.
     */
    resolvedDocProps?: Record<string, unknown> | null;
  },
): Promise<string> {
  if (options.DocumentComponent) {
    const docProps =
      options.resolvedDocProps ?? (await loadUserDocumentInitialProps(options.DocumentComponent));
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
  const renderProps = options.props ?? { pageProps: options.pageProps };
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
    props: renderProps,
    params: options.params,
    routePattern: options.routePattern,
    safeJsonStringify: options.safeJsonStringify,
    scriptNonce: options.scriptNonce,
    nextData: options.nextData,
    vinext: options.vinext,
  });
  const bodyMarker = "<!--VINEXT_STREAM_BODY-->";

  // Custom `_document.getInitialProps()` may opt in to wrapping the page tree
  // via `ctx.renderPage({ enhanceApp, enhanceComponent })` (e.g. for
  // styled-components / emotion style collection). When that contract is in
  // use the body must be a single complete string before `_document` renders
  // — Next.js does this in `loadDocumentInitialProps` and we mirror it here.
  // The streaming path stays as the default for the common case where the
  // user does not define `getInitialProps`. The contract (including
  // `withScriptNonce` and `styles` rendering) lives in the shared helper so
  // prod and dev stay in lockstep.
  const documentRenderPage = await runDocumentRenderPage({
    DocumentComponent: options.DocumentComponent,
    enhancePageElement: options.enhancePageElement,
    renderToReadableStream: options.renderToReadableStream,
    // Render the collected `styles` fragment with the plain stream renderer
    // rather than the full `<Document>` shell renderer — the styles tree is a
    // standalone fragment, so it doesn't need the heavier document pipeline.
    // Mirrors the dev path, which passes its `renderToStringAsync` wrapper.
    renderStylesToString: async (element) =>
      readStreamAsText(await options.renderToReadableStream(element)),
    scriptNonce: options.scriptNonce,
    context: {
      err: options.err,
      req: options.documentReqRes?.req,
      res: options.documentReqRes?.res,
      pathname: options.routePattern,
      query: options.query ?? options.params,
      asPath: options.routeUrl,
    },
  });
  if (options.documentReqRes?.res.headersSent && options.documentReqRes.responsePromise) {
    return options.documentReqRes.responsePromise;
  }

  let bodyStream: ReadableStream<Uint8Array>;
  if (documentRenderPage.status === "rendered") {
    bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(documentRenderPage.bodyHtml));
        controller.close();
      },
    });
  } else {
    // Render the page FIRST so that <Head> and other SSR state collectors
    // (e.g. styled-jsx, useServerInsertedHTML) are populated before we read
    // them. This fixes a race condition where head styles were silently dropped
    // because they were collected before the page had finished rendering.
    // Mirrors Next.js fix: vercel/next.js@9853944
    //
    // Built lazily here: when the renderPage contract produced the body
    // (`rendered`), this element is never used, so there's no point
    // constructing the tree on that path.
    const pageElement = withScriptNonce(
      React.createElement(React.Fragment, null, options.createPageElement(renderProps)),
      options.scriptNonce,
    );
    bodyStream = await options.renderToReadableStream(pageElement);
  }

  // Fold any head tags returned by `_document.getInitialProps()` into the
  // dedupe pipeline before getSSRHeadHTML serialises the final <head>. Mirrors
  // Next.js's `_document` contract. `runDocumentRenderPage` already invokes
  // `getInitialProps` for the renderPage contract, so reuse
  // the head it surfaced rather than calling it a second time. Only the
  // `skipped` path (no override, or no `enhancePageElement` wired) falls back to
  // the standalone helper — which itself skips the unmodified default shim.
  if (documentRenderPage.status === "skipped") {
    await callDocumentGetInitialProps(options.DocumentComponent, options.setDocumentInitialHead);
  } else {
    options.setDocumentInitialHead?.(documentRenderPage.head);
  }

  const headFromShim = options.getSSRHeadHTML?.() ?? "";
  // Trace meta tags from the active OpenTelemetry context. When the
  // allow-list is unset (the common case) or OTel is not installed,
  // `getClientTraceMetadataHTML` returns "" and we forward the head HTML
  // verbatim — keeping the no-op path zero-overhead.
  const traceMetaHTML = getClientTraceMetadataHTML(options.clientTraceMetadata);
  let ssrHeadHTML = headFromShim;
  if (traceMetaHTML) ssrHeadHTML += `\n  ${traceMetaHTML}`;
  // `styles` returned by `_document.getInitialProps()` (e.g. collected
  // styled-components / emotion <style> tags) is already rendered to a string
  // by the shared helper, ready to merge into the SSR head.
  if (documentRenderPage.status === "rendered" && documentRenderPage.stylesHTML) {
    ssrHeadHTML += `\n  ${documentRenderPage.stylesHTML}`;
  }
  const shellHtml = await buildPagesShellHtml(bodyMarker, fontHeadHTML, nextDataScript, {
    assetTags: options.assetTags,
    DocumentComponent: options.DocumentComponent,
    renderDocumentToString: options.renderDocumentToString,
    ssrHeadHTML,
    // When the renderPage path already invoked getInitialProps, reuse its
    // resolved props instead of calling it a second time.
    // `skipped` means it was never invoked → fall through to the fast path.
    resolvedDocProps: documentRenderPage.status === "skipped" ? null : documentRenderPage.docProps,
  });

  options.clearSsrContext();

  const markerIndex = shellHtml.indexOf(bodyMarker);
  const shellPrefix = shellHtml.slice(0, markerIndex);
  const shellSuffix = shellHtml.slice(markerIndex + bodyMarker.length);
  const responseHeaders = new Headers({ "Content-Type": "text/html" });
  const finalStatus = applyGsspHeaders(
    responseHeaders,
    options.gsspRes ?? options.documentReqRes?.res ?? null,
    options.statusCode,
  );

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
    responseHeaders.set("Cache-Control", ISR_NO_STORE_CACHE_CONTROL);
  } else if (options.isrRevalidateSeconds) {
    // Fresh ISR (MISS) response: route through the CDN adapter so edge adapters
    // emit CDN-Cache-Control + a path-based Cache-Tag (matching revalidatePath,
    // which Pages Router invalidation uses) while the default emits Cache-Control.
    const isrPathname = options.routeUrl.split("?")[0];
    const stem = isrPathname.endsWith("/") ? isrPathname.slice(0, -1) : isrPathname;
    applyCdnResponseHeaders(responseHeaders, {
      cacheControl: buildMissIsrCacheControl(options.isrRevalidateSeconds, options.expireSeconds),
      tags: [encodeCacheTag(`_N_T_${stem || "/"}`)],
    });
    setCacheStateHeaders(responseHeaders, "MISS");
  } else if (options.gsspRes && !userSetCacheControl) {
    // Default for getServerSideProps responses, matching Next.js
    // pages-handler.ts (revalidate: 0 → getCacheControlHeader). Without this,
    // CDNs and browsers could cache per-request gssp responses.
    responseHeaders.set("Cache-Control", ISR_NEVER_CACHE_CONTROL);
  }
  if (options.fontLinkHeader) {
    responseHeaders.set("Link", options.fontLinkHeader);
  }

  // Bot / crawler path: buffer the complete HTML, emit as a single chunk, and
  // attach an ETag. Bots (Googlebot, Google-PageRenderer, etc.) cannot parse
  // incrementally-streamed HTML — metadata tags pushed after the initial <head>
  // flush are invisible to them.
  //
  // INTENTIONAL DIVERGENCE FROM NEXT.JS: Next.js gates this buffering/ETag on
  // `!result.isDynamic` (i.e., only static/ISR pages get it, not GSSP pages).
  // Vinext instead gates on the crawler User-Agent — buffering ALL bot requests
  // regardless of whether the route uses getServerSideProps or getStaticProps.
  // This is deliberate: edge-runtime streaming is unreliable for bots on any
  // route type, so the UA check is the correct signal here. See also the ISR
  // cache-HIT path in `pages-page-data.ts` which applies the same UA gate for
  // consistent ETag coverage on cached responses.
  //
  // A consequence of UA-gating is that the ETag/304 path below can also fire
  // for dynamic (GSSP) responses, which Next.js never 304s (`isDynamic` renders
  // skip ETag generation entirely). The risk is minimal in practice: GSSP
  // responses carry `Cache-Control: private, no-cache, no-store,
  // must-revalidate`, so a conformant client won't revalidate them with
  // `If-None-Match` — but a dynamic page may legitimately differ between the
  // ETag-generating render and a revalidation request.
  //
  // When the incoming `If-None-Match` header matches the computed ETag, return
  // `304 Not Modified` with no body (mirrors Next.js `sendEtagResponse`
  // semantics in packages/next/src/server/send-payload.ts, with weak-ETag
  // comparison per RFC 7232 §2.3.2).
  //
  // NOTE: This check is intentionally placed after the Cache-Control / header
  // setup above so bot responses still carry the correct cache semantics.
  if (options.userAgent && isPagesStreamingBot(options.userAgent)) {
    const fullHtml = await readStreamAsText(compositeStream);
    const etag = generatePagesETag(fullHtml);
    responseHeaders.set("ETag", etag);
    const noCacheRequested = requestsNoCache(options.requestCacheControl);
    if (!noCacheRequested && options.ifNoneMatch && etagMatches(etag, options.ifNoneMatch)) {
      return new Response(null, {
        status: 304,
        headers: responseHeaders,
      });
    }
    return new Response(fullHtml, {
      status: finalStatus,
      headers: responseHeaders,
    });
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
