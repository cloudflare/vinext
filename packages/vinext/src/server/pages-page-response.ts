import React, { type ComponentType, type ReactNode } from "react";
import { minifyStyledJsxCss } from "../plugins/styled-jsx.js";
import { _runWithCacheState } from "../shims/cache.js";
import { runWithPrivateCache } from "../shims/cache-runtime.js";
import { runWithFetchCache } from "../shims/fetch-cache.js";
import { renderHeadNodesToHTML } from "../shims/head.js";
import { runWithServerInsertedHTMLState } from "../shims/navigation-state.js";
import { withScriptNonce } from "../shims/script-nonce-context.js";
import { createNonceAttribute, escapeHtmlAttr } from "./html.js";
import { getClientTraceMetadataHtml } from "./trace-metadata.js";

export const PAGES_INDEFINITE_REVALIDATE_SECONDS = 31536000;
const PAGES_NEXT_DEPLOY_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const PAGES_HTML_BOT_UA_RE =
  /Googlebot(?!-)|Googlebot$|[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i;

function usesPagesNextDeployCacheControl(): boolean {
  return process.env.VINEXT_NEXT_DEPLOY_CACHE_CONTROL === "1";
}

export function isPagesHtmlBotUserAgent(userAgent: string): boolean {
  return PAGES_HTML_BOT_UA_RE.test(userAgent);
}

export function buildPagesIsrCacheControl(
  revalidateSeconds: number | undefined,
  cacheState: "HIT" | "MISS" | "STALE",
): string {
  if (usesPagesNextDeployCacheControl()) {
    return PAGES_NEXT_DEPLOY_CACHE_CONTROL;
  }

  if (cacheState === "STALE") {
    return "s-maxage=0, stale-while-revalidate";
  }

  return `s-maxage=${revalidateSeconds ?? 60}, stale-while-revalidate`;
}

type PagesFontPreload = {
  href: string;
  type: string;
};

type PagesDocumentComponent = ComponentType<Record<string, unknown>> & {
  getInitialProps?: (ctx: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

type PagesRenderPageOptions =
  | ((Component: ComponentType<Record<string, unknown>>) => ComponentType<Record<string, unknown>>)
  | {
      enhanceApp?: (
        App: ComponentType<Record<string, unknown>>,
      ) => ComponentType<Record<string, unknown>>;
      enhanceComponent?: (
        Component: ComponentType<Record<string, unknown>>,
      ) => ComponentType<Record<string, unknown>>;
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

type PagesReactReadableStream = ReadableStream<Uint8Array> & {
  allReady?: Promise<void>;
};

type PagesNextDataPayload = Record<string, unknown> & {
  props: Record<string, unknown>;
  page: string;
  query: Record<string, unknown>;
  buildId: string | null;
};

type RenderPagesPageResponseOptions = {
  appProps?: Record<string, unknown>;
  assetTags: string;
  buildId: string | null;
  clientTraceMetadata?: readonly string[];
  clearSsrContext: () => void;
  createPageElement: (
    pageProps: Record<string, unknown>,
    renderOptions?: PagesRenderPageOptions | null,
  ) => ReactNode;
  crossOrigin?: string | null;
  DocumentComponent: PagesDocumentComponent | null;
  documentProps?: Record<string, unknown> | undefined;
  documentRenderPageOptions?: PagesRenderPageOptions | null;
  flushPreloads?: (() => Promise<void> | void) | undefined;
  fontLinkHeader: string;
  fontPreloads: PagesFontPreload[];
  getFontLinks: () => string[];
  getFontStyles: () => string[];
  getSSRHeadHTML?: (() => string) | undefined;
  gsspRes: PagesGsspResponse | null;
  isFallback?: boolean;
  isGssp?: boolean;
  isGsp?: boolean;
  isrCacheKey: (router: string, pathname: string) => string;
  isrRevalidateSeconds: number | null;
  isrSet: (
    key: string,
    data: {
      kind: "PAGES";
      html: string;
      pageData: Record<string, unknown>;
      headers: undefined;
      status: undefined;
    },
    revalidateSeconds: number,
  ) => Promise<void>;
  i18n: PagesI18nRenderContext;
  pageModuleUrl?: string;
  pageProps: Record<string, unknown>;
  appModuleUrl?: string;
  params: Record<string, unknown>;
  renderDocumentToString: (element: ReactNode) => Promise<string>;
  renderHeadPrepassToStringAsync?: ((element: ReactNode) => Promise<string>) | undefined;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
  renderToReadableStream: (element: ReactNode) => Promise<PagesReactReadableStream>;
  resetSSRHead?: (() => void) | undefined;
  routePattern: string;
  routeUrl: string;
  safeJsonStringify: (value: unknown) => string;
  scriptNonce?: string;
  shouldBufferResponse?: boolean;
};

function buildPagesFontHeadHtml(
  fontLinks: string[],
  fontPreloads: PagesFontPreload[],
  fontStyles: string[],
  scriptNonce?: string,
  crossOrigin?: string | null,
): string {
  let html = "";
  const nonceAttr = createNonceAttribute(scriptNonce);
  const crossOriginAttr = createCrossOriginAttribute(crossOrigin);

  for (const link of fontLinks) {
    html += `<link rel="stylesheet"${nonceAttr} href="${escapeHtmlAttr(link)}" />\n  `;
  }

  for (const preload of fontPreloads) {
    html += `<link rel="preload"${nonceAttr} href="${escapeHtmlAttr(preload.href)}" as="font" type="${escapeHtmlAttr(preload.type)}"${crossOriginAttr} />\n  `;
  }

  if (fontStyles.length > 0) {
    html += `<style data-vinext-fonts${nonceAttr}>${fontStyles.join("\n")}</style>\n  `;
  }

  return html;
}

function getDocumentHeadHTML(documentProps?: Record<string, unknown>): string {
  const head = documentProps?.head;
  if (!Array.isArray(head)) return "";
  return renderHeadNodesToHTML(head);
}

function createCrossOriginAttribute(crossOrigin?: string | null): string {
  if (!crossOrigin) {
    return " crossorigin";
  }
  return ` crossorigin="${escapeHtmlAttr(crossOrigin)}"`;
}

function createOptionalCrossOriginAttribute(crossOrigin?: string | null): string {
  if (!crossOrigin) {
    return "";
  }
  return ` crossorigin="${escapeHtmlAttr(crossOrigin)}"`;
}

function getHtmlAttr(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`, "i");
  const match = attrs.match(pattern);
  return match?.[1] ?? match?.[2];
}

function addMissingAttrToScriptsAndPreloads(html: string, name: string, value: string): string {
  const escapedAttr = ` ${name}="${escapeHtmlAttr(value)}"`;
  return html.replace(/<(script|link)\b([^>]*)>/gi, (match, tagName: string, attrs: string) => {
    if (new RegExp(`\\s${name}=`, "i").test(attrs)) {
      return match;
    }
    if (
      tagName.toLowerCase() === "link" &&
      !/\srel=(?:"(?:modulepreload|preload)"|'(?:modulepreload|preload)'|(?:modulepreload|preload)(?:\s|>|$))/i.test(
        attrs,
      )
    ) {
      return match;
    }
    return `<${tagName}${attrs}${escapedAttr}>`;
  });
}

function buildPagesNextDataPayload(
  options: Pick<
    RenderPagesPageResponseOptions,
    | "buildId"
    | "i18n"
    | "isFallback"
    | "isGsp"
    | "isGssp"
    | "pageModuleUrl"
    | "pageProps"
    | "appModuleUrl"
    | "appProps"
    | "crossOrigin"
    | "params"
    | "routePattern"
    | "safeJsonStringify"
    | "scriptNonce"
  >,
): PagesNextDataPayload {
  const nextDataPayload: PagesNextDataPayload = {
    props: { ...options.appProps, pageProps: options.pageProps },
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

  if (options.isGssp) {
    nextDataPayload.gssp = true;
  }
  if (options.isGsp) {
    nextDataPayload.gsp = true;
  }

  if (options.pageModuleUrl || options.appModuleUrl) {
    nextDataPayload.__vinext = {
      ...(options.pageModuleUrl ? { pageModuleUrl: options.pageModuleUrl } : {}),
      ...(options.appModuleUrl ? { appModuleUrl: options.appModuleUrl } : {}),
    };
  }

  return nextDataPayload;
}

export function buildPagesNextDataScript(
  options: Pick<
    RenderPagesPageResponseOptions,
    | "buildId"
    | "i18n"
    | "isFallback"
    | "isGsp"
    | "isGssp"
    | "pageModuleUrl"
    | "pageProps"
    | "appModuleUrl"
    | "appProps"
    | "crossOrigin"
    | "params"
    | "routePattern"
    | "safeJsonStringify"
    | "scriptNonce"
  >,
): string {
  const nextDataPayload = buildPagesNextDataPayload(options);
  const localeGlobals = options.i18n.locales
    ? `;window.__VINEXT_LOCALE__=${options.safeJsonStringify(options.i18n.locale)}` +
      `;window.__VINEXT_LOCALES__=${options.safeJsonStringify(options.i18n.locales)}` +
      `;window.__VINEXT_DEFAULT_LOCALE__=${options.safeJsonStringify(options.i18n.defaultLocale)}`
    : "";

  const nextDataJson = options.safeJsonStringify(nextDataPayload);
  const nonceAttr = createNonceAttribute(options.scriptNonce);
  const crossOriginAttr = createOptionalCrossOriginAttribute(options.crossOrigin);
  return (
    `<script id="__NEXT_DATA__" type="application/json"${nonceAttr}${crossOriginAttr}>${nextDataJson}</script>` +
    `<script${nonceAttr}${crossOriginAttr}>window.__NEXT_DATA__ = ${nextDataJson}${localeGlobals}</script>`
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
    crossOrigin?: string | null;
    documentProps?: Record<string, unknown> | undefined;
    ssrHeadHTML: string;
  },
): Promise<string> {
  if (options.DocumentComponent) {
    let html = await options.renderDocumentToString(
      React.createElement(options.DocumentComponent, options.documentProps ?? {}),
    );
    let documentScriptNonce: string | undefined;
    let documentScriptCrossOrigin: string | undefined;
    html = html.replace(
      /<vinext-next-scripts\b([^>]*)>__NEXT_SCRIPTS__<\/vinext-next-scripts>/i,
      (_match, attrs: string) => {
        documentScriptNonce = getHtmlAttr(attrs, "data-vinext-next-script-nonce");
        documentScriptCrossOrigin = getHtmlAttr(attrs, "data-vinext-next-script-crossorigin");
        return nextDataScript;
      },
    );
    html = html.replace("__NEXT_MAIN__", bodyMarker);
    if (options.ssrHeadHTML || options.assetTags || fontHeadHTML) {
      const suffixBeforeAssets = options.ssrHeadHTML ? "\n  " : "";
      html = html.replace(
        "</head>",
        `${fontHeadHTML}${options.ssrHeadHTML}${suffixBeforeAssets}${options.assetTags}\n</head>`,
      );
    }
    html = html.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
    html = html.replace("__NEXT_SCRIPTS__", nextDataScript);
    if (!html.includes("__NEXT_DATA__")) {
      html = html.replace("</body>", `  ${nextDataScript}\n</body>`);
    }
    if (documentScriptNonce) {
      html = addMissingAttrToScriptsAndPreloads(html, "nonce", documentScriptNonce);
    }
    if (documentScriptCrossOrigin || options.crossOrigin) {
      html = addMissingAttrToScriptsAndPreloads(
        html,
        "crossorigin",
        documentScriptCrossOrigin ?? options.crossOrigin ?? "",
      );
    }
    return html;
  }

  return (
    "<!DOCTYPE html>\n<html>\n<head>\n" +
    '  <meta charset="utf-8" data-next-head="" />\n' +
    '  <meta name="viewport" content="width=device-width" data-next-head="" />\n' +
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
  const decoder = new TextDecoder();
  const styleNormalizer = createPagesInlineStyleStreamNormalizer();

  return new ReadableStream({
    async start(controller) {
      const enqueueText = (text: string, flush = false) => {
        const normalized = styleNormalizer(text, flush);
        if (normalized) {
          controller.enqueue(encoder.encode(normalized));
        }
      };

      let pendingPrefix = shellPrefix;
      const reader = bodyStream.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          enqueueText(pendingPrefix + decoder.decode(chunk.value, { stream: true }));
          pendingPrefix = "";
        }
      } finally {
        reader.releaseLock();
      }
      enqueueText(pendingPrefix + decoder.decode());
      enqueueText(shellSuffix, true);
      controller.close();
    },
  });
}

function applyGsspHeaders(headers: Headers, gsspRes: PagesGsspResponse | null): number {
  if (!gsspRes) {
    return 200;
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
  return gsspRes.statusCode;
}

function buildWeakHtmlEtag(html: string): string {
  let hash = 2166136261;
  for (let i = 0; i < html.length; i++) {
    hash ^= html.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `W/"${html.length.toString(16)}-${(hash >>> 0).toString(16)}"`;
}

function runWithFreshPagesRenderState<T>(fn: () => Promise<T>): Promise<T> {
  return runWithServerInsertedHTMLState(() =>
    _runWithCacheState(() => runWithPrivateCache(() => runWithFetchCache(fn))),
  );
}

export function normalizePagesInlineStyleTags(html: string): string {
  const bodyIndex = html.search(/<body\b/i);
  if (bodyIndex === -1) return html;

  const prefix = html.slice(0, bodyIndex);
  const body = html.slice(bodyIndex);
  return prefix + normalizeInlineStyleTagsFragment(body);
}

function normalizeInlineStyleTagsFragment(html: string): string {
  return html.replace(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/gi, (match, attrs = "", css) => {
    if (!css.includes(":") && !css.includes("{")) return match;
    return `<style${attrs}>${minifyStyledJsxCss(css)}</style>`;
  });
}

function createPagesInlineStyleStreamNormalizer(): (text: string, flush?: boolean) => string {
  let sawBody = false;
  let pending = "";

  return (text, flush = false) => {
    pending += text;
    let output = "";

    if (!sawBody) {
      const bodyMatch = /<body\b[^>]*>/i.exec(pending);
      if (!bodyMatch) {
        if (flush) {
          output = pending;
          pending = "";
        } else if (pending.length > 4096) {
          output = pending.slice(0, -512);
          pending = pending.slice(-512);
        }
        return output;
      }

      const bodyEnd = bodyMatch.index + bodyMatch[0].length;
      output += pending.slice(0, bodyEnd);
      pending = pending.slice(bodyEnd);
      sawBody = true;
    }

    for (;;) {
      const lowerPending = pending.toLowerCase();
      const styleStart = lowerPending.indexOf("<style");
      if (styleStart === -1) {
        if (flush) {
          output += pending;
          pending = "";
          break;
        }

        // Keep a tiny tail so a split "<style" start tag can be recognized
        // when the next streamed chunk arrives, but do not hold ordinary body
        // HTML and delay Suspense fallbacks.
        const tailLength = Math.min(pending.length, "<style".length - 1);
        const emitLength = pending.length - tailLength;
        if (emitLength > 0) {
          output += pending.slice(0, emitLength);
          pending = pending.slice(emitLength);
        }
        break;
      }

      if (styleStart > 0) {
        output += pending.slice(0, styleStart);
        pending = pending.slice(styleStart);
        continue;
      }

      const styleEnd = lowerPending.indexOf("</style>");
      if (styleEnd === -1) {
        if (flush) {
          output += pending;
          pending = "";
        }
        break;
      }

      const completeStyleEnd = styleEnd + "</style>".length;
      output += normalizeInlineStyleTagsFragment(pending.slice(0, completeStyleEnd));
      pending = pending.slice(completeStyleEnd);
    }

    return output;
  };
}

export async function renderPagesPageResponse(
  options: RenderPagesPageResponseOptions,
): Promise<Response> {
  const createPageElement = () =>
    withScriptNonce(
      React.createElement(
        React.Fragment,
        null,
        options.createPageElement(options.pageProps, options.documentRenderPageOptions ?? null),
      ),
      options.scriptNonce,
    );
  const pageElement = createPageElement();

  options.resetSSRHead?.();
  if (options.renderHeadPrepassToStringAsync) {
    await runWithFreshPagesRenderState(() =>
      options.renderHeadPrepassToStringAsync!(createPageElement()),
    );
  }
  const pageHeadHTML = options.getSSRHeadHTML?.() ?? "";
  const documentHeadHTML = getDocumentHeadHTML(options.documentProps);
  options.resetSSRHead?.();
  await options.flushPreloads?.();

  const fontHeadHTML = buildPagesFontHeadHtml(
    options.getFontLinks(),
    options.fontPreloads,
    options.getFontStyles(),
    options.scriptNonce,
    options.crossOrigin,
  );
  const traceMetadataHTML =
    options.gsspRes !== null ? await getClientTraceMetadataHtml(options.clientTraceMetadata) : "";
  const nextDataPayload = buildPagesNextDataPayload({
    appProps: options.appProps,
    buildId: options.buildId,
    i18n: options.i18n,
    isFallback: options.isFallback,
    isGsp: options.isGsp,
    isGssp: options.gsspRes !== null,
    pageModuleUrl: options.pageModuleUrl,
    pageProps: options.pageProps,
    appModuleUrl: options.appModuleUrl,
    crossOrigin: options.crossOrigin,
    params: options.params,
    routePattern: options.routePattern,
    safeJsonStringify: options.safeJsonStringify,
    scriptNonce: options.scriptNonce,
  });
  const nextDataScript = buildPagesNextDataScript({
    appProps: options.appProps,
    buildId: options.buildId,
    i18n: options.i18n,
    isFallback: options.isFallback,
    isGsp: options.isGsp,
    isGssp: options.gsspRes !== null,
    pageModuleUrl: options.pageModuleUrl,
    pageProps: options.pageProps,
    appModuleUrl: options.appModuleUrl,
    crossOrigin: options.crossOrigin,
    params: options.params,
    routePattern: options.routePattern,
    safeJsonStringify: options.safeJsonStringify,
    scriptNonce: options.scriptNonce,
  });
  const documentProps = options.DocumentComponent
    ? { ...options.documentProps, __NEXT_DATA__: nextDataPayload }
    : options.documentProps;
  const bodyMarker = "<!--VINEXT_STREAM_BODY-->";
  const shellHtml = await buildPagesShellHtml(bodyMarker, fontHeadHTML, nextDataScript, {
    assetTags: options.assetTags,
    crossOrigin: options.crossOrigin,
    DocumentComponent: options.DocumentComponent,
    documentProps,
    renderDocumentToString: options.renderDocumentToString,
    ssrHeadHTML: [pageHeadHTML, documentHeadHTML, traceMetadataHTML].filter(Boolean).join("\n  "),
  });

  options.clearSsrContext();

  const markerIndex = shellHtml.indexOf(bodyMarker);
  const shellPrefix = shellHtml.slice(0, markerIndex);
  const shellSuffix = shellHtml.slice(markerIndex + bodyMarker.length);
  const bodyStream = await runWithFreshPagesRenderState(() =>
    options.renderToReadableStream(pageElement),
  );

  if (
    // Keep nonce-bearing pages out of ISR writes: rewritePagesCachedHtml()
    // later matches the cached __NEXT_DATA__ block via a bare <script> marker.
    !options.scriptNonce &&
    options.isrRevalidateSeconds !== null &&
    options.isrRevalidateSeconds > 0
  ) {
    const isrElement = React.createElement(
      React.Fragment,
      null,
      options.createPageElement(options.pageProps, options.documentRenderPageOptions ?? null),
    );
    const isrHtml = await options.renderIsrPassToStringAsync(isrElement);
    const fullHtml = normalizePagesInlineStyleTags(shellPrefix + isrHtml + shellSuffix);
    const isrPathname = options.routeUrl.split("?")[0];
    const cacheKey = options.isrCacheKey("pages", isrPathname);
    await options.isrSet(
      cacheKey,
      {
        kind: "PAGES",
        html: fullHtml,
        pageData: options.pageProps,
        headers: undefined,
        status: undefined,
      },
      options.isrRevalidateSeconds,
    );
  }

  const responseHeaders = new Headers({ "Content-Type": "text/html" });
  const finalStatus = applyGsspHeaders(responseHeaders, options.gsspRes);

  if (options.scriptNonce) {
    responseHeaders.set("Cache-Control", "no-store, must-revalidate");
  } else if (options.isFallback) {
    responseHeaders.set(
      "Cache-Control",
      usesPagesNextDeployCacheControl()
        ? PAGES_NEXT_DEPLOY_CACHE_CONTROL
        : "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  } else if (options.isrRevalidateSeconds) {
    responseHeaders.set(
      "Cache-Control",
      buildPagesIsrCacheControl(options.isrRevalidateSeconds, "MISS"),
    );
    responseHeaders.set("X-Vinext-Cache", "MISS");
  } else if (options.gsspRes && !responseHeaders.has("Cache-Control")) {
    responseHeaders.set("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate");
  }
  if (options.fontLinkHeader) {
    responseHeaders.set("Link", options.fontLinkHeader);
  }

  if (options.shouldBufferResponse) {
    await bodyStream.allReady;
    const bodyHtml = await new Response(bodyStream).text();
    const fullHtml = normalizePagesInlineStyleTags(shellPrefix + bodyHtml + shellSuffix);
    if (!responseHeaders.has("ETag")) {
      responseHeaders.set("ETag", buildWeakHtmlEtag(fullHtml));
    }
    return new Response(fullHtml, {
      status: finalStatus,
      headers: responseHeaders,
    });
  }

  const compositeStream = await buildPagesCompositeStream(bodyStream, shellPrefix, shellSuffix);

  const response = new Response(compositeStream, {
    status: finalStatus,
    headers: responseHeaders,
  }) as PagesStreamedHtmlResponse;
  // Mark the normal streamed HTML render so the Node prod server can strip
  // stale Content-Length only for this path, not for custom gSSP responses.
  response.__vinextStreamedHtmlResponse = true;
  return response;
}
