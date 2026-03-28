/// <reference types="@vitejs/plugin-rsc/types" />

import type { ReactNode } from "react";
import { Fragment, createElement as createReactElement } from "react";
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server.edge";
import * as clientReferences from "virtual:vite-rsc/client-references";
import type { NavigationContext } from "../shims/navigation.js";
import {
  ServerInsertedHTMLContext,
  clearServerInsertedHTML,
  flushServerInsertedHTML,
  setNavigationContext,
  useServerInsertedHTML,
} from "../shims/navigation.js";
import { runWithNavigationContext } from "../shims/navigation-state.js";
import { safeJsonStringify } from "./html.js";
import { createRscEmbedTransform, createTickBufferedTransform } from "./app-ssr-stream.js";

export interface FontPreload {
  href: string;
  type: string;
}

export interface FontData {
  links?: string[];
  styles?: string[];
  preloads?: FontPreload[];
}

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

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
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

function renderFontHtml(fontData?: FontData): string {
  if (!fontData) return "";

  let fontHTML = "";

  for (const url of fontData.links ?? []) {
    fontHTML += `<link rel="stylesheet" href="${escapeHtmlAttr(url)}" />\n`;
  }

  for (const preload of fontData.preloads ?? []) {
    fontHTML += `<link rel="preload" href="${escapeHtmlAttr(preload.href)}" as="font" type="${escapeHtmlAttr(preload.type)}" crossorigin />\n`;
  }

  if (fontData.styles && fontData.styles.length > 0) {
    fontHTML += `<style data-vinext-fonts>${fontData.styles.join("\n")}</style>\n`;
  }

  return fontHTML;
}

function extractModulePreloadHtml(bootstrapScriptContent?: string): string {
  if (!bootstrapScriptContent) return "";

  const match = bootstrapScriptContent.match(/import\("([^"]+)"\)/);
  if (!match?.[1]) return "";

  return `<link rel="modulepreload" href="${escapeHtmlAttr(match[1])}" />\n`;
}

function buildHeadInjectionHtml(
  navContext: NavigationContext | null,
  bootstrapScriptContent: string | undefined,
  insertedHTML: string,
  fontHTML: string,
): string {
  const paramsScript =
    "<script>self.__VINEXT_RSC_PARAMS__=" +
    safeJsonStringify(navContext?.params ?? {}) +
    "</script>";
  const navPayload = {
    pathname: navContext?.pathname ?? "/",
    searchParams: navContext?.searchParams ? [...navContext.searchParams.entries()] : [],
  };
  const navScript =
    "<script>self.__VINEXT_RSC_NAV__=" + safeJsonStringify(navPayload) + "</script>";

  return (
    paramsScript +
    navScript +
    extractModulePreloadHtml(bootstrapScriptContent) +
    insertedHTML +
    fontHTML
  );
}

export async function handleSsr(
  rscStream: ReadableStream<Uint8Array>,
  navContext: NavigationContext | null,
  fontData?: FontData,
): Promise<ReadableStream<Uint8Array>> {
  return runWithNavigationContext(async () => {
    await preloadClientReferences();

    if (navContext) {
      setNavigationContext(navContext);
    }

    clearServerInsertedHTML();

    try {
      const [ssrStream, embedStream] = rscStream.tee();
      const rscEmbed = createRscEmbedTransform(embedStream);

      let flightRoot: Promise<unknown> | null = null;

      function VinextFlightRoot(): ReactNode {
        if (!flightRoot) {
          flightRoot = createFromReadableStream(ssrStream);
        }
        return flightRoot as unknown as ReactNode;
      }

      const root = createReactElement(VinextFlightRoot);
      const ssrRoot = ServerInsertedHTMLContext
        ? createReactElement(
            ServerInsertedHTMLContext.Provider,
            { value: useServerInsertedHTML },
            root,
          )
        : root;

      const bootstrapScriptContent = await import.meta.viteRsc.loadBootstrapScriptContent("index");

      const htmlStream = await renderToReadableStream(ssrRoot, {
        bootstrapScriptContent,
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

      const insertedHTML = renderInsertedHtml(flushServerInsertedHTML());
      const fontHTML = renderFontHtml(fontData);
      const injectHTML = buildHeadInjectionHtml(
        navContext,
        bootstrapScriptContent,
        insertedHTML,
        fontHTML,
      );

      return htmlStream.pipeThrough(createTickBufferedTransform(rscEmbed, injectHTML));
    } finally {
      setNavigationContext(null);
      clearServerInsertedHTML();
    }
  }) as Promise<ReadableStream<Uint8Array>>;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("//")) {
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
