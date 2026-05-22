/// <reference types="@vitejs/plugin-rsc/types" />

import "./server-globals.js";
import type { ReactNode } from "react";
import type { ReactFormState } from "react-dom/client";
import { Fragment, createElement as createReactElement, use } from "react";
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server.edge";
import clientReferences from "virtual:vite-rsc/client-references";
import type { NavigationContext } from "vinext/shims/navigation";
import {
  ServerInsertedHTMLContext,
  appRouterInstance,
  clearServerInsertedHTML,
  renderServerInsertedHTML,
  setNavigationContext,
  useServerInsertedHTML,
} from "vinext/shims/navigation";
import { runWithNavigationContext } from "vinext/shims/navigation-state";
import { runWithRootParamsScope, type RootParams } from "vinext/shims/root-params";
import { isOpenRedirectShaped } from "./request-pipeline.js";
import { notFoundResponse } from "./http-error-responses.js";
import { withScriptNonce } from "vinext/shims/script-nonce-context";
import {
  BeforeInteractiveContext,
  type BeforeInteractiveInlineScript,
} from "vinext/shims/before-interactive-context";
import {
  createInlineScriptTag,
  createNonceAttribute,
  escapeHtmlAttr,
  safeJsonStringify,
} from "./html.js";
import {
  createNavigationRuntimeRscMetadataScript,
  createRscEmbedTransform,
  createTickBufferedTransform,
} from "./app-ssr-stream.js";
import { deferUntilStreamConsumed } from "./app-page-stream.js";
import { createSsrErrorMetaRenderer } from "./app-ssr-error-meta.js";
import { AppElementsWire, type AppWireElements } from "./app-elements.js";
import { ElementsContext, Slot } from "vinext/shims/slot";
import { AppRouterContext } from "vinext/shims/internal/app-router-context";
import { createClientReferencePreloader } from "./app-client-reference-preloader.js";
import { RSC_FORM_STATE_GLOBAL } from "./app-browser-hydration.js";

export type FontPreload = {
  href: string;
  type: string;
};

export type FontData = {
  links?: string[];
  styles?: string[];
  preloads?: FontPreload[];
};

const clientReferencePreloader = createClientReferencePreloader({
  getReferences() {
    return clientReferences;
  },
  getClientRequire() {
    return globalThis.__vite_rsc_client_require__;
  },
  onPreloadError(id, error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[vinext] failed to preload client ref:", id, error);
    }
  },
});

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

/**
 * Render captured `<Script strategy="beforeInteractive">` inline scripts to
 * HTML, ready to splice immediately after `<head ...>` opens. Each entry has
 * already had its inline content escaped via `escapeInlineContent(..., "script")`
 * inside the Script shim, so this function only quotes the attributes that
 * actually go on the tag (id, nonce, plus the residual passthroughs).
 *
 * Keeping this function colocated with the rest of the head-injection
 * helpers makes it obvious where the boundary is: anything passed through
 * here is being concatenated directly into HTML; treat the inputs
 * accordingly.
 */
// Conservative subset of the HTML attribute-name grammar. Must start with a
// letter and contain only letters, digits, underscores, hyphens, or dots —
// enough to round-trip data-* and standard attributes (`async`, `defer`,
// `type`, `crossorigin`, etc.) without ever splicing a `"`/`>`/whitespace
// into the unquoted *name* position where escaping wouldn't help.
const VALID_ATTR_NAME = /^[a-zA-Z][\w.-]*$/;

function renderBeforeInteractiveInlineScripts(
  scripts: readonly BeforeInteractiveInlineScript[],
): string {
  if (scripts.length === 0) return "";
  let html = "";
  for (const script of scripts) {
    let attrs = "";
    if (script.id) {
      attrs += ` id="${escapeHtmlAttr(script.id)}"`;
    }
    attrs += createNonceAttribute(script.nonce);
    if (script.attributes) {
      for (const [key, value] of Object.entries(script.attributes)) {
        // Attribute *values* go through escapeHtmlAttr below. The *name*
        // can't be escaped — a malformed key would break the tag — so we
        // gate at the boundary instead of trying to neutralise it.
        if (!VALID_ATTR_NAME.test(key)) continue;
        if (value === true) {
          attrs += ` ${key}`;
        } else if (typeof value === "string") {
          attrs += ` ${key}="${escapeHtmlAttr(value)}"`;
        }
      }
    }
    html += `<script${attrs}>${script.innerHTML}</script>`;
  }
  return html;
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

/**
 * Extract the bootstrap module URL from the `import("...")` string that
 * `import.meta.viteRsc.loadBootstrapScriptContent("index")` returns.
 *
 * The plugin-rsc helper returns the bootstrap as an inline call so we can
 * inject it via `bootstrapScriptContent`. We instead pass the URL to
 * React's `bootstrapModules` option so a real
 * `<script type="module" src="…">` tag ends up in the streamed HTML —
 * this exposes the URL to anything that reads `script.attribs.src` (e.g.
 * the Next.js asset-prefix fixture test). The same URL also feeds the
 * `<link rel="modulepreload">` we emit ahead of the bootstrap.
 *
 * Returns `undefined` when the helper produced no URL (older plugin-rsc
 * versions, or a custom client entry that disables bootstrap content).
 */
function extractBootstrapModuleUrl(bootstrapScriptContent?: string): string | undefined {
  if (!bootstrapScriptContent) return undefined;
  // Accept either quote style — plugin-rsc currently emits double quotes
  // (`import("…")`) but a future version could switch to single quotes,
  // and there's no public contract documenting which is used.
  const match = bootstrapScriptContent.match(/import\(["']([^"']+)["']\)/);
  return match?.[1] ?? undefined;
}

function buildModulePreloadHtml(bootstrapModuleUrl?: string, nonce?: string): string {
  if (!bootstrapModuleUrl) return "";
  return `<link rel="modulepreload"${createNonceAttribute(nonce)} href="${escapeHtmlAttr(bootstrapModuleUrl)}" />\n`;
}

function buildHeadInjectionHtml(
  navContext: NavigationContext | null,
  bootstrapModuleUrl: string | undefined,
  formState: ReactFormState | null,
  insertedHTML: string,
  fontHTML: string,
  scriptNonce?: string,
): string {
  const navPayload = {
    pathname: navContext?.pathname ?? "/",
    searchParams: navContext?.searchParams ? [...navContext.searchParams.entries()] : [],
  };
  const rscMetadataScript = createInlineScriptTag(
    createNavigationRuntimeRscMetadataScript(navContext?.params ?? {}, navPayload),
    scriptNonce,
  );
  const formStateScript =
    formState === null
      ? ""
      : createInlineScriptTag(
          "self[" + safeJsonStringify(RSC_FORM_STATE_GLOBAL) + "]=" + safeJsonStringify(formState),
          scriptNonce,
        );

  return (
    rscMetadataScript +
    formStateScript +
    buildModulePreloadHtml(bootstrapModuleUrl, scriptNonce) +
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
    formState?: ReactFormState | null;
    basePath?: string;
    rootParams?: RootParams;
    /** When true, wait for the full React tree (including Suspense boundaries)
     *  to resolve before returning the HTML stream. Used for static prerender
     *  and ISR cache writes to avoid caching fallback content. */
    waitForAllReady?: boolean;
  },
): Promise<ReadableStream<Uint8Array>> {
  return runWithNavigationContext(async () => {
    await clientReferencePreloader.preload();

    if (navContext) {
      setNavigationContext(navContext);
    }

    clearServerInsertedHTML();

    const cleanup = (): void => {
      setNavigationContext(null);
      clearServerInsertedHTML();
    };

    const rootParams = options?.rootParams ?? {};
    return runWithRootParamsScope(rootParams, async () => {
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

        const flightRootElement = createReactElement(VinextFlightRoot);
        const root = AppRouterContext
          ? createReactElement(
              AppRouterContext.Provider,
              { value: appRouterInstance },
              flightRootElement,
            )
          : flightRootElement;
        const ssrTree = ServerInsertedHTMLContext
          ? createReactElement(
              ServerInsertedHTMLContext.Provider,
              { value: useServerInsertedHTML },
              root,
            )
          : root;

        // Capture inline `<Script strategy="beforeInteractive">` content so the
        // SSR stream transform can emit it immediately after `<head ...>`
        // opens — ahead of every React-emitted resource hint. The Script shim
        // pushes here when it sees an inline beforeInteractive Script and
        // returns `null` from its render so React does not also serialize the
        // tag where the user wrote it (where Fizz would push it *after* the
        // hoisted stylesheets/modulepreloads). See
        // packages/vinext/src/shims/script.tsx for the capture side.
        const beforeInteractiveInlineScripts: BeforeInteractiveInlineScript[] = [];
        const registerBeforeInteractiveInlineScript = (
          script: BeforeInteractiveInlineScript,
        ): void => {
          beforeInteractiveInlineScripts.push(script);
        };
        const treeWithBeforeInteractive = createReactElement(
          BeforeInteractiveContext.Provider,
          { value: registerBeforeInteractiveInlineScript },
          ssrTree,
        );
        const ssrRoot = withScriptNonce(treeWithBeforeInteractive, options?.scriptNonce);

        // plugin-rsc returns the bootstrap as `import("<url>")` so callers can
        // inject it via `bootstrapScriptContent`. We hand the URL to React's
        // `bootstrapModules` option instead so the streamed HTML contains a
        // real `<script type="module" src="<url>">` tag — exposing the URL
        // to anything that inspects `script.attribs.src` (e.g. the Next.js
        // asset-prefix fixture test "bundles should return 200 on served
        // assetPrefix"). Mirrors Next.js's app-render path which passes
        // `bootstrapScripts: [{ src }]` for the same reason; we use
        // `bootstrapModules` because vinext's chunks are native ES modules
        // (Vite output) so a `type="module"` tag is the correct loader.
        //
        // In dev, `<url>` is a Vite dev URL like
        // `/@id/__x00__virtual:vinext-app-browser-entry`; the browser fetches
        // it as a module from the dev server. In prod it's the hashed bundle
        // URL (e.g. `/_next/static/index-abc123.js`, optionally prefixed by
        // `assetPrefix`). Both are valid `<script type="module" src=…>` targets.
        const bootstrapScriptContent = await import.meta.viteRsc.loadBootstrapScriptContent(
          "index",
        );
        const bootstrapModuleUrl = extractBootstrapModuleUrl(bootstrapScriptContent);
        const errorMetaRenderer = createSsrErrorMetaRenderer({
          basePath: options?.basePath,
        });

        const htmlStream = await renderToReadableStream(ssrRoot, {
          // `bootstrapScriptContent` was previously how vinext injected the
          // dynamic-import call. `bootstrapModules` performs the same work
          // natively (and exposes the URL in the DOM), so passing both would
          // load the bootstrap module twice.
          //
          // CSP implications of using `bootstrapModules` instead of inline
          // `bootstrapScriptContent`:
          //  - Apps no longer need `script-src 'unsafe-inline'` to load the
          //    bootstrap (improvement — inline imports required `'unsafe-inline'`).
          //  - Apps that restrict script sources need `'self'` for the
          //    common case, or the CDN origin when `assetPrefix` is an
          //    absolute URL like `https://cdn.example.com`.
          //  - React still applies `nonce` to the emitted
          //    `<script type="module" src=…>` tag, so nonce-based CSP
          //    (`script-src 'nonce-…' 'strict-dynamic'`) keeps working.
          bootstrapModules: bootstrapModuleUrl ? [bootstrapModuleUrl] : undefined,
          formState: options?.formState ?? null,
          nonce: options?.scriptNonce,
          onError(error) {
            errorMetaRenderer.capture(error);

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

        // When producing static output (prerender / ISR cache writes), wait for
        // the full React tree to resolve before emitting bytes. This prevents
        // Suspense fallback content from being serialized to the cache.
        // Matches Next.js waitForAllReady forkpoint in renderToNodeFizzStream.
        if (options?.waitForAllReady === true) {
          await htmlStream.allReady;
        }

        const fontHTML = renderFontHtml(fontData, options?.scriptNonce);
        let didInjectHeadHTML = false;
        const getInsertedHTML = (): string => {
          const insertedHTML = renderInsertedHtml(renderServerInsertedHTML());
          const errorMetaHTML = errorMetaRenderer.flush();
          if (didInjectHeadHTML) return insertedHTML + errorMetaHTML;

          didInjectHeadHTML = true;
          return buildHeadInjectionHtml(
            navContext,
            bootstrapModuleUrl,
            options?.formState ?? null,
            insertedHTML + errorMetaHTML,
            fontHTML,
            options?.scriptNonce,
          );
        };

        // The transform calls this once when it splices after `<head ...>`.
        // By that point React Fizz has rendered the layout's `<head>` children
        // (which is where the Script shim registers), so the captured array is
        // populated. We deliberately return a snapshot — `flushBuffered` will
        // not re-invoke us, and any beforeInteractive Script that renders
        // later (inside a Suspense boundary further down the tree) falls back
        // to its inline location, matching the documented guarantee that
        // ordering applies to scripts rendered in the initial shell.
        const getBeforeInteractiveHeadHTML = (): string =>
          renderBeforeInteractiveInlineScripts(beforeInteractiveInlineScripts);

        return deferUntilStreamConsumed(
          htmlStream.pipeThrough(
            createTickBufferedTransform(rscEmbed, getInsertedHTML, getBeforeInteractiveHeadHTML),
          ),
          cleanup,
        );
      } catch (error) {
        cleanup();
        throw error;
      }
    });
  }) as Promise<ReadableStream<Uint8Array>>;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Block protocol-relative URL open redirects (including percent-encoded
    // variants like /%5Cevil.com/). See request-pipeline.ts for details.
    if (isOpenRedirectShaped(url.pathname)) {
      return notFoundResponse();
    }

    const rscModule = await import.meta.viteRsc.loadModule<{
      default(request: Request): Promise<Response | string | null | undefined>;
    }>("rsc", "index");
    const result = await rscModule.default(request);

    if (result instanceof Response) {
      return result;
    }

    if (result == null) {
      return notFoundResponse();
    }

    return new Response(String(result), { status: 200 });
  },
};
