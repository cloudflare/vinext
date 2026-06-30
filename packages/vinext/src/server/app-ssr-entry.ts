/// <reference types="@vitejs/plugin-rsc/types" />

import "./server-globals.js";
import type { ReactNode } from "react";
import type { ReactFormState } from "react-dom/client";
import { preinitModule } from "react-dom";
import { Fragment, createElement as createReactElement, use } from "react";
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import type { RenderToReadableStreamOptions } from "react-dom/server";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server.edge";
import clientReferences from "virtual:vite-rsc/client-references";
import type { NavigationContext } from "vinext/shims/navigation-server";
import {
  ServerInsertedHTMLContext,
  clearServerInsertedHTML,
  getBfcacheIdMapContext,
  registerServerInsertedHTMLCallback,
  renderServerInsertedHTML,
  setNavigationContext,
} from "vinext/shims/navigation-server";
import { runWithNavigationContext } from "vinext/shims/navigation-state";
import { runWithRootParamsScope, type RootParams } from "vinext/shims/root-params";
import { isOpenRedirectShaped } from "./open-redirect.js";
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
import { renderBeforeInteractiveInlineScripts } from "./before-interactive-head.js";
import {
  createNavigationRuntimeRscMetadataScript,
  createRscEmbedTransform,
  createTickBufferedTransform,
  type InitialNavigationCacheMetadata,
} from "./app-ssr-stream.js";
import type { AppSsrRenderResult } from "./app-page-stream.js";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";
import { createSsrErrorMetaRenderer } from "./app-ssr-error-meta.js";
import { createInitialDevServerErrorScript } from "./dev-initial-server-error.js";
import { getClientTraceMetadataHTML } from "./client-trace-metadata.js";
import { AppElementsWire, type AppWireElements } from "./app-elements.js";
import { createInitialBfcacheMaps } from "./app-bfcache-identity.js";
import { BfcacheStateKeyMapContext, ElementsContext, Slot } from "vinext/shims/slot";
import { AppRouterContext } from "vinext/shims/internal/app-router-context";
import { createClientReferencePreloader } from "./app-client-reference-preloader.js";
import { RSC_FORM_STATE_GLOBAL } from "./app-browser-hydration.js";
import { isPprFallbackShellAbortError } from "vinext/shims/ppr-fallback-shell";
import DefaultGlobalError from "vinext/shims/default-global-error";
import { appendAssetDeploymentIdQuery } from "../utils/deployment-id.js";
import { ssrAppRouterInstance } from "./app-ssr-router-instance.js";
// @ts-expect-error — resolved by the vinext build plugin in SSR environments.
import pagesClientAssets from "virtual:vinext-pages-client-assets";
import { setPagesClientAssets, type PagesClientAssets } from "./pages-client-assets.js";

setPagesClientAssets(pagesClientAssets as PagesClientAssets);

/**
 * `@types/react-dom` does not yet type `maxHeadersLength` (it pairs with the
 * already-typed `onHeaders` to cap the emitted preload `Link` header). React
 * supports it at runtime, so augment the option type locally.
 */
type SsrRenderOptions = RenderToReadableStreamOptions & {
  maxHeadersLength?: number;
};

/**
 * Default cap for the preload `Link` header, matching Next.js's
 * `defaultConfig.reactMaxHeadersLength`. Used when no config value threads
 * through (e.g. error-boundary renders) so React's internal cap agrees with
 * the response-layer combine cap.
 */
const DEFAULT_REACT_MAX_HEADERS_LENGTH = 6000;

export type FontPreload = {
  href: string;
  type: string;
};

export type FontData = {
  links?: string[];
  styles?: string[];
  preloads?: FontPreload[];
};

type StaticPrerender = typeof import("react-dom/static.edge").prerender;

function isReactDevelopmentRuntime(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  return Function.prototype.toString.call(createReactElement).includes("getOwner");
}

function isStaticPrerenderModule(value: unknown): value is { prerender: StaticPrerender } {
  return (
    typeof value === "object" &&
    value !== null &&
    "prerender" in value &&
    typeof value.prerender === "function"
  );
}

async function loadStaticPrerender(): Promise<StaticPrerender> {
  // Prefer the stable ESM entry in all environments. Future React dev builds
  // may export prerender() here, so this is the first path we attempt.
  const staticRenderer: unknown = await import("react-dom/static.edge");
  if (isStaticPrerenderModule(staticRenderer)) {
    return staticRenderer.prerender;
  }

  // Fallback: React development builds historically did not export prerender()
  // from the ESM entry, so reach into the CJS artifact. The path is fragile
  // because it depends on React's internal file layout, but it is only used
  // when the stable ESM entry does not provide prerender().
  if (isReactDevelopmentRuntime()) {
    try {
      const [{ createRequire }, path] = await Promise.all([
        import("node:module"),
        import("node:path"),
      ]);
      const require = createRequire(import.meta.url);
      const reactDomPackageJson = require.resolve("react-dom/package.json");
      const reactDomDir = path.dirname(reactDomPackageJson);
      const devRendererPath = path.join(reactDomDir, "cjs/react-dom-server.edge.development.js");
      const devRenderer: unknown = await import(/* @vite-ignore */ devRendererPath);
      if (isStaticPrerenderModule(devRenderer)) {
        return devRenderer.prerender;
      }
      // Node.js ESM import of a CJS module wraps the exports in `default`.
      const devRendererDefault =
        typeof devRenderer === "object" &&
        devRenderer !== null &&
        "default" in devRenderer &&
        devRenderer.default;
      if (isStaticPrerenderModule(devRendererDefault)) {
        return devRendererDefault.prerender;
      }
      throw new Error("react-dom development renderer did not expose prerender().");
    } catch (error) {
      throw new Error("[vinext] Failed to load React static development renderer.", {
        cause: error,
      });
    }
  }

  throw new Error("[vinext] react-dom/static.edge did not expose prerender().");
}

function createUtf8Stream(html: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(html));
      controller.close();
    },
  });
}

function buildBootstrapModuleScript(bootstrapModuleUrl?: string, nonce?: string): string {
  if (!bootstrapModuleUrl) return "";
  return (
    `<script type="module"${createNonceAttribute(nonce)} src="` +
    escapeHtmlAttr(bootstrapModuleUrl) +
    '" id="_R_" async=""></script>'
  );
}

function renderSsrErrorDocumentShell(
  bootstrapModuleUrl?: string,
  nonce?: string,
): ReadableStream<Uint8Array> {
  const html = renderToStaticMarkup(
    createReactElement(DefaultGlobalError, {
      error: null,
    }),
  ).replace("<style>", '<style data-vinext-error-shell-style="">');
  const bootstrapScript = buildBootstrapModuleScript(bootstrapModuleUrl, nonce);
  if (!bootstrapScript) {
    return createUtf8Stream(`<!DOCTYPE html>${html}`);
  }

  const documentClose = "</body></html>";
  if (!html.endsWith(documentClose)) {
    return createUtf8Stream(`<!DOCTYPE html>${html}${bootstrapScript}`);
  }

  return createUtf8Stream(
    `<!DOCTYPE html>${html.slice(0, -documentClose.length)}${bootstrapScript}${documentClose}`,
  );
}

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
const BfcacheIdMapContext = getBfcacheIdMapContext();

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

function renderFontHtml(
  fontData?: FontData,
  nonce?: string,
  options: { includeStyles?: boolean } = {},
): string {
  if (!fontData) return "";

  let fontHTML = "";
  const nonceAttr = createNonceAttribute(nonce);
  const includeStyles = options.includeStyles ?? true;

  for (const url of fontData.links ?? []) {
    fontHTML += `<link rel="stylesheet"${nonceAttr} href="${escapeHtmlAttr(appendAssetDeploymentIdQuery(url))}" />\n`;
  }

  for (const preload of fontData.preloads ?? []) {
    fontHTML += `<link rel="preload"${nonceAttr} href="${escapeHtmlAttr(appendAssetDeploymentIdQuery(preload.href))}" as="font" type="${escapeHtmlAttr(preload.type)}" crossorigin />\n`;
  }

  if (includeStyles && fontData.styles && fontData.styles.length > 0) {
    fontHTML += `<style data-vinext-fonts${nonceAttr}>${fontData.styles.join("\n")}</style>\n`;
  }

  return fontHTML;
}

function hasInlineCssManifest(manifest: Record<string, string> | undefined): boolean {
  return manifest !== undefined && Object.keys(manifest).length > 0;
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
  navContext: NavigationContext,
  bootstrapModuleUrl: string | undefined,
  formState: ReactFormState | null,
  insertedHTML: string,
  fontHTML: string,
  dynamicStaleTimeSeconds?: number,
  scriptNonce?: string,
): string {
  const navPayload = {
    pathname: navContext.pathname,
    searchParams: [...navContext.searchParams.entries()],
  };
  const rscMetadataScript = createInlineScriptTag(
    createNavigationRuntimeRscMetadataScript(
      navContext.params,
      navPayload,
      dynamicStaleTimeSeconds,
    ),
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

function requireNavigationContext(navContext: NavigationContext | null): NavigationContext {
  if (!navContext) {
    // Guaranteed by the RSC handler (app-rsc-handler.ts) before every main
    // render and by the ISR/revalidation path (app-page-dispatch.ts). Fallback
    // boundary renderers synthesize one (app-page-boundary-render.ts) when
    // request scope is gone.
    throw new Error("App SSR requires navigation context for BFCache state keys");
  }
  return navContext;
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
    pprFallbackShellSignal?: AbortSignal;
    formState?: ReactFormState | null;
    basePath?: string;
    /**
     * Allow-list of OpenTelemetry propagation keys (from
     * `experimental.clientTraceMetadata`) to render as `<meta>` tags in the
     * SSR head. Undefined or empty disables emission entirely.
     */
    clientTraceMetadata?: readonly string[];
    /**
     * Maximum total length (in characters) of the preload `Link` header React
     * emits during SSR. `0` disables emission. From `reactMaxHeadersLength` in
     * `next.config`. Undefined falls back to React's own default.
     */
    reactMaxHeadersLength?: number;
    rootParams?: RootParams;
    /** Dev-only: original server error to surface in the browser overlay. */
    initialDevServerError?: unknown;
    /** When true, wait for the full React tree (including Suspense boundaries)
     *  to resolve before returning the HTML stream. Used for static prerender
     *  and ISR cache writes to avoid caching fallback content. */
    waitForAllReady?: boolean;
    fallbackToErrorDocumentOnShellError?: boolean;
    dynamicStaleTimeSeconds?: number;
    getInitialNavigationCacheMetadata?: () => InitialNavigationCacheMetadata;
  },
): Promise<AppSsrRenderResult> {
  return runWithNavigationContext(async () => {
    const ssrNavigationContext = requireNavigationContext(navContext);

    await clientReferencePreloader.preload();

    setNavigationContext(ssrNavigationContext);

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
          rscEmbed = createRscEmbedTransform(
            options.sideStream,
            options?.scriptNonce,
            options?.getInitialNavigationCacheMetadata,
          );
          if (options.capturedRscDataRef) {
            options.capturedRscDataRef.value = rscEmbed.getRawBuffer();
          }
        } else {
          const [s1, s2] = rscStream.tee();
          ssrStream = s1;
          rscEmbed = createRscEmbedTransform(
            s2,
            options?.scriptNonce,
            options?.getInitialNavigationCacheMetadata,
          );
        }

        let flightRoot: PromiseLike<AppWireElements> | null = null;

        function VinextFlightRoot(): ReactNode {
          for (const moduleUrl of pagesClientAssets.appBootstrapPreinitModules ?? []) {
            preinitModule(moduleUrl, {
              as: "script",
              nonce: options?.scriptNonce,
            });
          }
          if (!flightRoot) {
            flightRoot = createFromReadableStream<AppWireElements>(ssrStream);
          }
          const wireElements = use(flightRoot);
          const elements = AppElementsWire.decode(wireElements);
          const metadata = AppElementsWire.readMetadata(elements);
          const bfcacheMaps = createInitialBfcacheMaps({
            elements,
            metadata,
            // Normalized inside the function to match the client navigation
            // snapshot pathname (SSR/client Activity key parity).
            pathname: ssrNavigationContext.pathname,
          });
          const routeTree = createReactElement(
            ElementsContext.Provider,
            { value: elements },
            createReactElement(Slot, { id: metadata.routeId }),
          );
          const stateKeyTree = createReactElement(
            BfcacheStateKeyMapContext.Provider,
            { value: bfcacheMaps.stateKeys },
            routeTree,
          );
          // During SSR we only provide the id *map*, seeded entirely with the
          // INITIAL_BFCACHE_ID sentinel. BfcacheSlotBoundary may still publish a
          // BfcacheSegmentIdContext value here, but every map entry is the "0"
          // sentinel, so formatPublicBfcacheId resolves useRouter().bfcacheId to
          // the public hydration sentinel ("_b_0_") regardless until the client
          // context takes over. Per-segment minted ids are browser-only.
          return BfcacheIdMapContext
            ? createReactElement(
                BfcacheIdMapContext.Provider,
                { value: bfcacheMaps.bfcacheIds },
                stateKeyTree,
              )
            : stateKeyTree;
        }

        const flightRootElement = createReactElement(VinextFlightRoot);
        const root = AppRouterContext
          ? createReactElement(
              AppRouterContext.Provider,
              { value: ssrAppRouterInstance },
              flightRootElement,
            )
          : flightRootElement;
        const ssrTree = ServerInsertedHTMLContext
          ? createReactElement(
              ServerInsertedHTMLContext.Provider,
              { value: registerServerInsertedHTMLCallback },
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
        // Keep the bootstrap URL exactly as emitted by plugin-rsc. Appending a
        // deployment query here happens after Vite has generated the client
        // module graph, so the bootstrap entry gets a different module identity
        // from references to the same entry inside that graph. That splits the
        // React/RSC client singleton state and breaks hydration and server-action
        // FormData encoding. Normal built assets are versioned earlier through
        // Vite's renderBuiltUrl hook.
        const bootstrapModuleUrl = extractBootstrapModuleUrl(bootstrapScriptContent);
        const errorMetaRenderer = createSsrErrorMetaRenderer({
          basePath: options?.basePath,
        });

        const pprFallbackShellSignal = options?.pprFallbackShellSignal;
        // React emits a preload `Link` header (capped to `maxHeadersLength`)
        // via `onHeaders`. It fires before the shell resolves, so `linkHeader`
        // is populated by the time `renderToReadableStream` resolves below.
        // `0` disables emission entirely — skip the callback so React doesn't
        // warn about a non-positive `maxHeadersLength`. Fall back to the same
        // 6000 default the response-layer cap uses (React's own default is
        // 2000) so both caps agree when no config value threads through.
        let reactLinkHeader = "";
        const maxHeadersLength = options?.reactMaxHeadersLength ?? DEFAULT_REACT_MAX_HEADERS_LENGTH;
        const captureHeaders = maxHeadersLength > 0;

        const renderOptions: SsrRenderOptions = {
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
          onHeaders: captureHeaders
            ? (headers: Headers) => {
                const link = headers.get("Link");
                if (link) {
                  reactLinkHeader = link;
                }
              }
            : undefined,
          maxHeadersLength: captureHeaders ? maxHeadersLength : undefined,
          onError(error: unknown) {
            if (pprFallbackShellSignal && isPprFallbackShellAbortError(error)) {
              return undefined;
            }

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
        };

        let htmlStream: ReadableStream<Uint8Array>;
        let shellErrorRecovered = false;
        if (pprFallbackShellSignal) {
          const prerender = await loadStaticPrerender();
          const htmlAbortController = new AbortController();
          const pendingHtml = prerender(ssrRoot, {
            ...renderOptions,
            signal: htmlAbortController.signal,
          });
          setTimeout(() => htmlAbortController.abort(), 0);
          htmlStream = (await pendingHtml).prelude;
        } else {
          let streamingHtmlStream: Awaited<ReturnType<typeof renderToReadableStream>> | undefined;
          try {
            streamingHtmlStream = await renderToReadableStream(ssrRoot, {
              ...renderOptions,
            });

            if (options?.waitForAllReady === true) {
              await streamingHtmlStream.allReady;
            }

            htmlStream = streamingHtmlStream;
          } catch (error) {
            void streamingHtmlStream?.cancel().catch(() => {});
            if (
              options?.fallbackToErrorDocumentOnShellError !== true ||
              options?.waitForAllReady === true ||
              typeof (error as { digest?: unknown } | null)?.digest === "string"
            ) {
              throw error;
            }
            shellErrorRecovered = true;
            htmlStream = renderSsrErrorDocumentShell(bootstrapModuleUrl, options?.scriptNonce);
          }
        }

        // Populated before any SSR request runs: at prod-server startup
        // (prod-server.ts) or via build-time bundle injection (index.ts). Left
        // undefined in dev, which naturally disables inline CSS there.
        const inlineCssManifest = globalThis.__VINEXT_INLINE_CSS__;
        const fontStyles = fontData?.styles ?? [];
        const mergeFontStylesIntoInlineCss =
          fontStyles.length > 0 && hasInlineCssManifest(inlineCssManifest);
        const inlineCssFontStyles = mergeFontStylesIntoInlineCss ? fontStyles.join("\n") : "";
        const inlineCssFontStyleFallbackHTML = mergeFontStylesIntoInlineCss
          ? renderFontHtml({ styles: fontStyles }, options?.scriptNonce)
          : "";
        const fontHTML = renderFontHtml(fontData, options?.scriptNonce, {
          includeStyles: !mergeFontStylesIntoInlineCss,
        });
        // Trace meta tags only need to land in the document head once.
        // Read the active OTel context lazily so the value reflects the
        // span that was active when the SSR shell rendered. When
        // clientTraceMetadata is unset (the common case) this is empty.
        let traceMetaHTML: string | null = null;
        const getTraceMetaHTML = (): string => {
          if (traceMetaHTML === null) {
            traceMetaHTML = getClientTraceMetadataHTML(options?.clientTraceMetadata);
          }
          return traceMetaHTML;
        };
        let didInjectHeadHTML = false;
        const getInsertedHTML = (): string => {
          const insertedHTML = renderInsertedHtml(renderServerInsertedHTML());
          const errorMetaHTML = errorMetaRenderer.flush();
          const initialDevServerErrorHTML = createInitialDevServerErrorScript(
            options?.initialDevServerError,
            options?.scriptNonce,
          );
          if (didInjectHeadHTML) return insertedHTML + errorMetaHTML;

          didInjectHeadHTML = true;
          return buildHeadInjectionHtml(
            ssrNavigationContext,
            bootstrapModuleUrl,
            options?.formState ?? null,
            insertedHTML + errorMetaHTML + getTraceMetaHTML() + initialDevServerErrorHTML,
            fontHTML,
            options?.dynamicStaleTimeSeconds,
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

        const finalStream = deferUntilStreamConsumed(
          htmlStream.pipeThrough(
            createTickBufferedTransform(
              rscEmbed,
              getInsertedHTML,
              getBeforeInteractiveHeadHTML,
              inlineCssManifest,
              inlineCssFontStyles,
              inlineCssFontStyleFallbackHTML,
              options?.scriptNonce,
            ),
          ),
          cleanup,
        );

        return {
          htmlStream: finalStream,
          // `metadataReady` resolves eagerly precisely *because* `allReady` was
          // already awaited above when `waitForAllReady` is set (the prerender
          // path). At that point the React tree is fully rendered, so all
          // render-time metadata (cache life, headers, captured RSC errors) is
          // already settled and there is nothing left for the lifecycle to wait
          // on. The promise exists to keep `renderAppPageLifecycle` agnostic to
          // *where* the blocking happens — do not move the `allReady` await onto
          // this promise expecting it to be load-bearing in production.
          metadataReady: Promise.resolve(),
          capturedRscData: options?.capturedRscDataRef?.value ?? null,
          shellErrorRecovered,
          linkHeader: reactLinkHeader,
        };
      } catch (error) {
        cleanup();
        throw error;
      }
    });
  }) as Promise<AppSsrRenderResult>;
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
