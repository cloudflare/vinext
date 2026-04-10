import React, { type ComponentType, type ReactNode } from "react";
import { withScriptNonce } from "../shims/script-nonce-context.js";
import { createInlineScriptTag, createNonceAttribute, escapeHtmlAttr } from "./html.js";

export type PagesFontPreload = {
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

export type RenderPagesPageResponseOptions = {
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
  gsspRes: PagesGsspResponse | null;
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
  pageProps: Record<string, unknown>;
  params: Record<string, unknown>;
  renderDocumentToString: (element: ReactNode) => Promise<string>;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
  renderToReadableStream: (element: ReactNode) => Promise<ReadableStream<Uint8Array>>;
  resetSSRHead?: (() => void) | undefined;
  routePattern: string;
  routeUrl: string;
  safeJsonStringify: (value: unknown) => string;
  scriptNonce?: string;
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
    | "pageProps"
    | "params"
    | "routePattern"
    | "safeJsonStringify"
    | "scriptNonce"
  >,
): string {
  const nextDataPayload: Record<string, unknown> = {
    props: { pageProps: options.pageProps },
    page: options.routePattern,
    query: options.params,
    buildId: options.buildId,
    isFallback: false,
  };

  if (options.i18n.locales) {
    nextDataPayload.locale = options.i18n.locale;
    nextDataPayload.locales = options.i18n.locales;
    nextDataPayload.defaultLocale = options.i18n.defaultLocale;
    nextDataPayload.domainLocales = options.i18n.domainLocales;
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
    let html = await options.renderDocumentToString(React.createElement(options.DocumentComponent));
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

  return (
    "<!DOCTYPE html>\n<html>\n<head>\n" +
    '  <meta charset="utf-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
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
    pageProps: options.pageProps,
    params: options.params,
    routePattern: options.routePattern,
    safeJsonStringify: options.safeJsonStringify,
    scriptNonce: options.scriptNonce,
  });
  const bodyMarker = "<!--VINEXT_STREAM_BODY-->";
  const shellHtml = await buildPagesShellHtml(bodyMarker, fontHeadHTML, nextDataScript, {
    assetTags: options.assetTags,
    DocumentComponent: options.DocumentComponent,
    renderDocumentToString: options.renderDocumentToString,
    ssrHeadHTML: options.getSSRHeadHTML?.() ?? "",
  });

  options.clearSsrContext();

  const markerIndex = shellHtml.indexOf(bodyMarker);
  const shellPrefix = shellHtml.slice(0, markerIndex);
  const shellSuffix = shellHtml.slice(markerIndex + bodyMarker.length);
  const bodyStream = await options.renderToReadableStream(pageElement);
  const compositeStream = await buildPagesCompositeStream(bodyStream, shellPrefix, shellSuffix);

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
      options.createPageElement(options.pageProps),
    );
    const isrHtml = await options.renderIsrPassToStringAsync(isrElement);
    const fullHtml = shellPrefix + isrHtml + shellSuffix;
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
  } else if (options.isrRevalidateSeconds) {
    responseHeaders.set(
      "Cache-Control",
      `s-maxage=${options.isrRevalidateSeconds}, stale-while-revalidate`,
    );
    responseHeaders.set("X-Vinext-Cache", "MISS");
  }
  if (options.fontLinkHeader) {
    responseHeaders.set("Link", options.fontLinkHeader);
  }

  const response = new Response(compositeStream, {
    status: finalStatus,
    headers: responseHeaders,
  }) as PagesStreamedHtmlResponse;
  // Mark the normal streamed HTML render so the Node prod server can strip
  // stale Content-Length only for this path, not for custom gSSP responses.
  response.__vinextStreamedHtmlResponse = true;
  return response;
}
