/// <reference types="@vitejs/plugin-rsc/types" />

import type { ReactNode } from "react";
import { Fragment, createElement as createReactElement, use } from "react";
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server.edge";
import * as clientReferences from "virtual:vite-rsc/client-references";
import type { NavigationContext } from "vinext/shims/navigation";
import {
  ServerInsertedHTMLContext,
  clearServerInsertedHTML,
  renderServerInsertedHTML,
  setNavigationContext,
  useServerInsertedHTML,
} from "vinext/shims/navigation";
import { runWithNavigationContext } from "vinext/shims/navigation-state";
import { isOpenRedirectShaped } from "./request-pipeline.js";
import { withScriptNonce } from "vinext/shims/script-nonce-context";
import {
  createInlineScriptTag,
  createNonceAttribute,
  escapeHtmlAttr,
  safeJsonStringify,
} from "./html.js";
import { createRscEmbedTransform, createTickBufferedTransform } from "./app-ssr-stream.js";
import { deferUntilStreamConsumed } from "./app-page-stream.js";
import { AppElementsWire, type AppWireElements } from "./app-elements.js";
import { ElementsContext, Slot } from "vinext/shims/slot";

export type FontPreload = {
  href: string;
  type: string;
};

export type FontData = {
  links?: string[];
  styles?: string[];
  preloads?: FontPreload[];
};

type ClientRequire = (id: string) => Promise<unknown>;

let clientRefsPreloaded = false;

function getClientReferenceRequire(): ClientRequire | undefined {
  return (
    globalThis as typeof globalThis & {
      __vite_rsc_client_require__?: ClientRequire;
    }
  ).__vite_rsc_client_require__;
}

async function preloadClientReferences(): Promise<void> {
  if (clientRefsPreloaded) return;

  const refs = (clientReferences as { default?: Record<string, unknown> }).default;
  const clientRequire = getClientReferenceRequire();
  if (!refs || !clientRequire) return;

  await Promise.all(
    Object.keys(refs).map((id) =>
      clientRequire(id).catch((error) => {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[vinext] failed to preload client ref:", id, error);
        }
      }),
    ),
  );

  clientRefsPreloaded = true;
}

function ssrErrorDigest(input: string): string {
  let hash = 5381;
  for (let i = input.length - 1; i >= 0; i--) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return Object.prototype.toString.call(error);
}

function renderInsertedHtml(insertedElements: readonly unknown[]): string {
  let insertedHTML = "";

  for (const element of insertedElements) {
    try {
      insertedHTML += renderToStaticMarkup(
        createReactElement(Fragment, null, element as ReactNode),
      );
    } catch {
      // Ignore individual callback failures so the rest of the page can render.
    }
  }

  return insertedHTML;
}

function renderFontHtml(fontData?: FontData, nonce?: string): string {
  if (!fontData) return "";

  let fontHTML = "";
  const nonceAttr = createNonceAttribute(nonce);

  for (const url of fontData.links ?? []) {
    fontHTML += `<link rel="stylesheet"${nonceAttr} href="${escapeHtmlAttr(url)}" />\n`;
  }

  for (const preload of fontData.preloads ?? []) {
    fontHTML += `<link rel="preload"${nonceAttr} href="${escapeHtmlAttr(preload.href)}" as="font" type="${escapeHtmlAttr(preload.type)}" crossorigin />\n`;
  }

  if (fontData.styles && fontData.styles.length > 0) {
    fontHTML += `<style data-vinext-fonts${nonceAttr}>${fontData.styles.join("\n")}</style>\n`;
  }

  return fontHTML;
}

function extractModulePreloadHtml(bootstrapScriptContent?: string, nonce?: string): string {
  if (!bootstrapScriptContent) return "";

  const match = bootstrapScriptContent.match(/import\("([^"]+)"\)/);
  if (!match?.[1]) return "";

  return `<link rel="modulepreload"${createNonceAttribute(nonce)} href="${escapeHtmlAttr(match[1])}" />\n`;
}

function buildHeadInjectionHtml(
  navContext: NavigationContext | null,
  bootstrapScriptContent: string | undefined,
  insertedHTML: string,
  fontHTML: string,
  scriptNonce?: string,
): string {
  const paramsScript = createInlineScriptTag(
    "self.__VINEXT_RSC_PARAMS__=" + safeJsonStringify(navContext?.params ?? {}),
    scriptNonce,
  );
  const navPayload = {
    pathname: navContext?.pathname ?? "/",
    searchParams: navContext?.searchParams ? [...navContext.searchParams.entries()] : [],
  };
  const navScript = createInlineScriptTag(
    "self.__VINEXT_RSC_NAV__=" + safeJsonStringify(navPayload),
    scriptNonce,
  );

  return (
    paramsScript +
    navScript +
    extractModulePreloadHtml(bootstrapScriptContent, scriptNonce) +
    insertedHTML +
    fontHTML
  );
}

export async function handleSsr(
  rscStream: ReadableStream<Uint8Array>,
  navContext: NavigationContext | null,
  fontData?: FontData,
  options?: {
    scriptNonce?: string;
    /** Pre-split side stream for embed+capture fusion. When provided,
     *  rscStream is fed directly to createFromReadableStream (no internal tee).
     *  The embed transform accumulates raw bytes. */
    sideStream?: ReadableStream<Uint8Array>;
    /** Out-parameter: filled with accumulated raw RSC bytes when sideStream is consumed. */
    capturedRscDataRef?: { value: Promise<ArrayBuffer> | null };
  },
): Promise<ReadableStream<Uint8Array>> {
  return runWithNavigationContext(async () => {
    await preloadClientReferences();

    if (navContext) {
      setNavigationContext(navContext);
    }

    clearServerInsertedHTML();

    const cleanup = (): void => {
      setNavigationContext(null);
      clearServerInsertedHTML();
    };

    try {
      // Fused tee path (#981): caller pre-split the stream. No internal tee needed.
      // sideStream carries both the embed transform and raw byte accumulation.
      // rscStream is used directly for createFromReadableStream (SSR).
      let ssrStream: ReadableStream<Uint8Array>;
      let rscEmbed;

      if (options?.sideStream) {
        ssrStream = rscStream;
        rscEmbed = createRscEmbedTransform(options.sideStream, options?.scriptNonce);
        if (options.capturedRscDataRef) {
          options.capturedRscDataRef.value = rscEmbed.getRawBuffer();
        }
      } else {
        const [s1, s2] = rscStream.tee();
        ssrStream = s1;
        rscEmbed = createRscEmbedTransform(s2, options?.scriptNonce);
      }

      let flightRoot: PromiseLike<AppWireElements> | null = null;

      function VinextFlightRoot(): ReactNode {
        if (!flightRoot) {
          flightRoot = createFromReadableStream<AppWireElements>(ssrStream);
        }
        const wireElements = use(flightRoot);
        const elements = AppElementsWire.decode(wireElements);
        const metadata = AppElementsWire.readMetadata(elements);
        return createReactElement(
          ElementsContext.Provider,
          { value: elements },
          createReactElement(Slot, { id: metadata.routeId }),
        );
      }

      const root = createReactElement(VinextFlightRoot);
      const ssrTree = ServerInsertedHTMLContext
        ? createReactElement(
            ServerInsertedHTMLContext.Provider,
            { value: useServerInsertedHTML },
            root,
          )
        : root;
      const ssrRoot = withScriptNonce(ssrTree, options?.scriptNonce);

      const bootstrapScriptContent = await import.meta.viteRsc.loadBootstrapScriptContent("index");

      const htmlStream = await renderToReadableStream(ssrRoot, {
        bootstrapScriptContent,
        nonce: options?.scriptNonce,
        onError(error) {
          if (error && typeof error === "object" && "digest" in error) {
            return String(error.digest);
          }

          if (process.env.NODE_ENV === "production" && error) {
            const message = getErrorMessage(error);
            const stack = error instanceof Error ? (error.stack ?? "") : "";
            return ssrErrorDigest(message + stack);
          }

          return undefined;
        },
      });

      const fontHTML = renderFontHtml(fontData, options?.scriptNonce);
      let didInjectHeadHTML = false;
      const getInsertedHTML = (): string => {
        const insertedHTML = renderInsertedHtml(renderServerInsertedHTML());
        if (didInjectHeadHTML) return insertedHTML;

        didInjectHeadHTML = true;
        return buildHeadInjectionHtml(
          navContext,
          bootstrapScriptContent,
          insertedHTML,
          fontHTML,
          options?.scriptNonce,
        );
      };

      return deferUntilStreamConsumed(
        htmlStream.pipeThrough(createTickBufferedTransform(rscEmbed, getInsertedHTML)),
        cleanup,
      );
    } catch (error) {
      cleanup();
      throw error;
    }
  }) as Promise<ReadableStream<Uint8Array>>;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Block protocol-relative URL open redirects (including percent-encoded
    // variants like /%5Cevil.com/). See request-pipeline.ts for details.
    if (isOpenRedirectShaped(url.pathname)) {
      return new Response("404 Not Found", { status: 404 });
    }

    const rscModule = await import.meta.viteRsc.loadModule<{
      default(request: Request): Promise<Response | string | null | undefined>;
    }>("rsc", "index");
    const result = await rscModule.default(request);

    if (result instanceof Response) {
      return result;
    }

    if (result == null) {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(String(result), { status: 200 });
  },
};
