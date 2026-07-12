// oxlint-disable typescript/consistent-type-definitions

/**
 * Global ambient type declarations for vinext runtime globals.
 *
 * These globals are injected at various points in the vinext lifecycle:
 *
 * - Window globals: set by the browser entry / RSC browser entry / server-rendered
 *   inline scripts; read by navigation shims and router shims.
 * - globalThis globals: set at build time (injected into the Cloudflare Worker entry)
 *   or at server startup; read during SSR to collect asset tags.
 * - process.env defines: replaced at compile time by Vite's `define` transform;
 *   read by image and draft-mode shims.
 *
 * Declaring them here removes all `(window as any)` and `(globalThis as any)`
 * escape hatches scattered across the source files.
 */

import type { Root } from "react-dom/client";
import type { OnRequestErrorHandler } from "./server/instrumentation";
import type { InitialDevServerErrorPayload } from "./server/dev-initial-server-error";
import type { CachedRscResponse, PrefetchCacheEntry } from "vinext/shims/navigation";
import type { NextRedirect, NextRewrite } from "./config/next-config";

// `window.next` is declared inline in `./client/window-next.ts` (mirroring
// Next.js's own pattern in `packages/next/src/client/next.ts`), not here, so
// the type is co-located with the installer that owns the runtime shape.

// ---------------------------------------------------------------------------
// Window globals — browser-side state shared across module boundaries
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    // ── Pages Router ────────────────────────────────────────────────────────

    /**
     * The React DOM root for Pages Router.
     * Set by the generated client entry (`entries/pages-client-entry.ts`) after
     * `hydrateRoot()`. Read by `shims/router.ts` to call `root.render()` during
     * navigation.
     */
    __VINEXT_ROOT__: Root | undefined;

    /**
     * Whether `reactStrictMode: true` is set in next.config for the Pages
     * Router. Set by the generated client entry and the dev hydration script
     * before `hydrateRoot()`. Read by `wrapWithRouterContext` in
     * `shims/router.ts` so the StrictMode wrap is applied on the initial
     * hydration AND every client-side navigation render — mirroring Next.js's
     * `process.env.__NEXT_STRICT_MODE` branch in `client/index.tsx`, which runs
     * for both the initial hydrate and subsequent `reactRoot.render()` calls.
     */
    __VINEXT_REACT_STRICT_MODE__: boolean | undefined;

    /**
     * High-resolution timestamp recorded after client hydration is usable.
     * Pages Router writes from the stable router provider after passive
     * effects can attach; App Router writes after the first committed tree
     * attaches browser router state.
     */
    __VINEXT_HYDRATED_AT: number | undefined;

    /**
     * Next.js test/runtime compatibility hydration marker.
     */
    __NEXT_HYDRATED: boolean | undefined;
    __NEXT_HYDRATED_AT: number | undefined;
    __NEXT_HYDRATED_CB: (() => void) | undefined;
    __VINEXT_INITIAL_DEV_ERRORS__: InitialDevServerErrorPayload[] | undefined;

    /**
     * The cached `_app` component for Pages Router.
     * Written and read by `shims/router.ts` to avoid re-importing on every
     * client-side navigation.
     */
    __VINEXT_APP__:
      | React.ComponentType<{
          Component: React.ComponentType<Record<string, unknown>>;
          pageProps: unknown;
          router?: unknown;
          [key: string]: unknown;
        }>
      | undefined;

    /**
     * Pages Router code-split loader map. Keys are route patterns in Next.js
     * bracket format (e.g. `/blog/[slug]`), values are dynamic `import()`
     * thunks that resolve to the page module. Vite code-splits each thunk
     * into its own chunk, so this is the manifest the client uses to load
     * the right page chunk on a client-side `_next/data` navigation.
     *
     * Set by the generated client entry (`entries/pages-client-entry.ts`)
     * before `hydrate()`. Read by `shims/router.ts` `navigateClient` after a
     * successful `/_next/data/<buildId>/<page>.json` fetch.
     *
     * `undefined` during SSR and on the very first hydration tick.
     */
    __VINEXT_PAGE_LOADERS__:
      | Record<string, () => Promise<{ default?: unknown; [key: string]: unknown }>>
      | undefined;

    /**
     * Pages Router pattern list. The route patterns (Next.js bracket format)
     * keyed in `__VINEXT_PAGE_LOADERS__`, in priority order (longest specific
     * pattern first, catch-alls last). Used by `shims/router.ts` to match an
     * incoming URL pathname to a registered loader.
     */
    __VINEXT_PAGE_PATTERNS__: string[] | undefined;

    /** Pages Router patterns whose modules export `getStaticProps`. */
    __VINEXT_PAGES_SSG_PATTERNS__: string[] | undefined;

    /** Pages Router patterns whose modules export `getServerSideProps`. */
    __VINEXT_PAGES_SSP_PATTERNS__: string[] | undefined;

    /** Resolved client-safe Pages Router redirects from next.config.js. */
    __VINEXT_CLIENT_REDIRECTS__: NextRedirect[] | undefined;

    /** Resolved client-safe rewrites from next.config.js. */
    __VINEXT_CLIENT_REWRITES__:
      | {
          beforeFiles: NextRewrite[];
          afterFiles: NextRewrite[];
          fallback: NextRewrite[];
        }
      | undefined;

    /**
     * Static `middleware/proxy` matcher config embedded for client-side Pages
     * Router middleware-effect probes. `undefined` means "match all", matching
     * Next.js's default when middleware has no matcher or the config was too
     * dynamic to statically serialize.
     */
    __VINEXT_MIDDLEWARE_MATCHER__: unknown;

    /**
     * Pages Router `_app` loader. Dynamic `import()` thunk for the user's
     * `pages/_app.tsx` module, or `undefined` when the app has no `_app`.
     * Set by the generated client entry; read by `shims/router.ts`
     * `navigateClient` to lazy-load `_app` on the first client-side
     * navigation.
     */
    __VINEXT_APP_LOADER__:
      | (() => Promise<{ default?: unknown; [key: string]: unknown }>)
      | undefined;

    /**
     * The current active locale for Pages Router internationalisation.
     * Injected as an inline `<script>` by the dev/prod server.
     */
    __VINEXT_LOCALE__: string | undefined;

    /**
     * All configured locales for Pages Router internationalisation.
     * Injected as an inline `<script>` by the dev/prod server.
     */
    __VINEXT_LOCALES__: string[] | undefined;

    /**
     * The default locale for Pages Router internationalisation.
     * Injected as an inline `<script>` by the dev/prod server.
     */
    __VINEXT_DEFAULT_LOCALE__: string | undefined;

    // ── App Router ──────────────────────────────────────────────────────────

    /**
     * The React DOM root for App Router.
     * Set by the browser RSC entry after the initial hydration `createRoot()`.
     * Used by E2E tests as a sentinel to detect that hydration has completed.
     */
    __VINEXT_RSC_ROOT__: Root | undefined;

    /**
     * App Router browser bootstrap ownership marker.
     * Shared on `window` because the same browser entry can be evaluated under
     * distinct ESM URLs when deployment-id cache busting meets split chunks.
     * Only the first module instance may consume the inlined RSC payload and
     * hydrate the document.
     */
    __VINEXT_RSC_BOOTSTRAP_STATE__: "starting" | "hydrated" | undefined;

    /**
     * A Promise that resolves when the current in-flight popstate RSC navigation
     * finishes rendering.
     * Set by the popstate handler in the browser RSC entry; read by
     * `shims/navigation.ts` to defer scroll restoration until after new content
     * has painted.
     * `null` when no navigation is in flight.
     */
    __VINEXT_RSC_PENDING__: Promise<void> | null | undefined;

    /**
     * In-memory cache of prefetched RSC responses, keyed by `.rsc` URL.
     * Lazily initialised on `window` by `shims/navigation.ts` so the same Map
     * instance is shared between the navigation shim and the Link component.
     */
    __VINEXT_RSC_PREFETCH_CACHE__: Map<string, PrefetchCacheEntry> | undefined;

    /**
     * Set of RSC URLs that have already been prefetched (or are in-flight).
     * Prevents duplicate prefetch requests for the same URL.
     */
    __VINEXT_RSC_PREFETCHED_URLS__: Set<string> | undefined;

    // ── Next.js conventional globals ────────────────────────────────────────
    //
    // `__NEXT_DATA__` is already declared by `next/dist/client/index.d.ts` as
    // `NEXT_DATA` from `next/dist/shared/lib/utils`. We intentionally do NOT
    // re-declare it here to avoid type conflicts. vinext-specific extensions
    // (__vinext) are accessed via the `VinextNextData` type in
    // `client/vinext-next-data.ts`.
    //
    // `window.next` is declared in `./client/window-next.ts` so its type
    // (`WindowNext`) lives next to the installer that owns the runtime shape.
  }

  // ── self globals used inside server-injected inline scripts ───────────────
  //
  // `self` in a browser context is the same object as `window`, but the
  // inline scripts that push RSC chunks use `self` rather than `window` for
  // compatibility with Web Workers (where `window` is undefined).

  /**
   * Array of RSC Flight protocol chunks streamed progressively by the server
   * via inline `<script>` tags. Text chunks are stored directly; non-UTF-8
   * chunks are stored as `[3, base64]` binary chunks, matching Next.js'
   * inlined Flight payload kind.
   * Each `<script>` calls `self.__VINEXT_RSC_CHUNKS__.push(chunk)`.
   * The browser RSC entry monkey-patches this array's `push` method to feed a
   * `ReadableStream` that is consumed by `react-server-dom-webpack`.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_RSC_CHUNKS__: (string | [3, string])[] | undefined;

  /**
   * Set to `true` by a final inline `<script>` when the server has finished
   * emitting all RSC chunks for the current request.
   * The browser RSC entry closes the `ReadableStream` when it sees this flag.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_RSC_DONE__: boolean | undefined;

  /**
   * Route params for the current page, embedded in `<head>` as a JSON inline
   * script so they are available synchronously before hydration.
   * Shape: `Record<string, string | string[]>` (same as Next.js `params`).
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_RSC_PARAMS__: Record<string, string | string[]> | undefined;

  /**
   * Navigation context embedded by `generateSsrEntry()` for hydration
   * snapshot consistency. Contains the pathname and searchParams used
   * during SSR so `useSyncExternalStore` `getServerSnapshot` matches the
   * SSR-rendered HTML.
   * `searchParams` is serialised as an array of `[key, value]` pairs to
   * preserve duplicate keys (e.g. `?tag=a&tag=b`).
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_RSC_NAV__: { pathname: string; searchParams: [string, string][] } | undefined;

  /**
   * Maps emitted CSS asset hrefs to file contents when next.config enables
   * `experimental.inlineCss`. Injected into edge bundles at build time and
   * populated by the Node.js production server at startup.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_INLINE_CSS__: Record<string, string> | undefined;

  /**
   * Current active locale, set on `globalThis` for server-side SSR rendering
   * (Pages Router with i18n).  Mirrors `window.__VINEXT_LOCALE__` for use in
   * environments where `window` is not available (e.g. Cloudflare Workers).
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_LOCALE__: string | undefined;

  /**
   * All configured locales, set on `globalThis` for server-side SSR rendering.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_LOCALES__: string[] | undefined;

  /**
   * Default locale, set on `globalThis` for server-side SSR rendering.
   * Also read client-side from `globalThis` in `shims/link.tsx` when `window`
   * is not yet available (e.g. during SSR of Link components).
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_DEFAULT_LOCALE__: string | undefined;

  /**
   * Configured Pages Router domain locale mappings, set on `globalThis` for
   * server-side rendering so `next/link` can resolve cross-domain locale hrefs
   * before hydration.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_DOMAIN_LOCALES__:
    | Array<{ domain: string; defaultLocale: string; locales?: string[]; http?: boolean }>
    | undefined;

  /**
   * Current request hostname, set on `globalThis` during Pages Router SSR so
   * locale-domain links can decide whether to render relative or absolute
   * hrefs.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_HOSTNAME__: string | undefined;

  /**
   * The onRequestError handler registered by instrumentation.ts.
   * Set by the instrumentation.ts register() function.
   *
   * The handler is stored on `globalThis` so it is visible across the RSC and
   * SSR Vite environments (separate module graphs, same Node.js process). With
   * `@cloudflare/vite-plugin` it runs entirely inside the Worker, so
   * `globalThis` is the Worker's global — also correct.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_onRequestErrorHandler__: OnRequestErrorHandler | undefined;

  /**
   * Vite RSC's SSR-side client-reference module loader.
   * Set by `@vitejs/plugin-rsc` and read by the App Router SSR entry before
   * React consumes the Flight stream, so first-request client references are
   * already resolved when Fizz renders the shell.
   */
  // oxlint-disable-next-line no-var
  var __vite_rsc_client_require__: ((id: string) => Promise<unknown>) | undefined;
}

// ---------------------------------------------------------------------------
// process.features — Node.js v22.10.0+ feature flags
// ---------------------------------------------------------------------------
//
// `process.features.typescript` is available since Node.js v22.10.0 and
// indicates whether the runtime has built-in TypeScript support (--experimental-strip-types).
// Declared here so we don't have to cast `process.features as any` at the call site.

declare global {
  namespace NodeJS {
    interface ProcessFeatures {
      /** Available since Node.js v22.10.0. `true` when run with --experimental-strip-types. */
      typescript?: boolean;
    }
  }
}

// ---------------------------------------------------------------------------
// process.env defines — compile-time Vite replacements
// ---------------------------------------------------------------------------
//
// These are replaced at bundle time by Vite's `define` transform in the
// vinext plugin (`index.ts`).  TypeScript needs to know they exist on
// `ProcessEnv` so we don't have to cast them to `string`.

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /**
       * Build ID string injected via Vite `define` at production build time.
       * Matches `next.config.js` → `buildId` (or a generated UUID when unset).
       * `undefined` in dev mode.
       */
      __VINEXT_BUILD_ID?: string;

      /**
       * Build-only coordination variable set by the `vinext build` CLI so that
       * every vinext() plugin instance in a single build (App Router buildApp +
       * the separate hybrid Pages Router vite.build) resolves the same build ID.
       * Distinct from `__VINEXT_BUILD_ID` (the runtime value baked via `define`)
       * so it never leaks into dev or standalone resolveBuildId() semantics.
       */
      __VINEXT_SHARED_BUILD_ID?: string;

      /**
       * Public App Router RSC compatibility identity injected via Vite
       * `define`. Used by browser navigation code to reject RSC payloads from
       * a different vinext build without exposing the raw build ID header.
       */
      __VINEXT_RSC_COMPATIBILITY_ID?: string;

      /**
       * Build-only coordination variable set by the `vinext build` CLI so that
       * every vinext() plugin instance in a single build resolves the same RSC
       * compatibility token (companion to `__VINEXT_SHARED_BUILD_ID`). Never read
       * by dev or standalone createRscCompatibilityId() resolution.
       */
      __VINEXT_SHARED_RSC_COMPATIBILITY_ID?: string;

      /**
       * Build-time secret that authenticates on-demand ISR revalidation
       * requests (the vinext analog of Next.js's prerender-manifest
       * `previewModeId`). Injected via a SERVER-ONLY Vite `define` so it is
       * baked identically into every server bundle — and therefore shared by
       * every Workers isolate — without ever reaching the client bundle. A
       * per-process random secret would mismatch across isolates because
       * `res.revalidate()`'s loopback `fetch()` can land on a different isolate;
       * a build-baked constant is the same in all of them.
       * `undefined` unless set during `vinext build` (so dev, and any non-CLI
       * build, omit it — see `getRevalidateSecret`'s single-process fallback).
       */
      __VINEXT_REVALIDATE_SECRET?: string;

      /**
       * Build-only coordination variable set by the `vinext build` CLI so that
       * every vinext() plugin instance in a single build (App Router buildApp +
       * the separate hybrid Pages Router vite.build) bakes the same revalidate
       * secret. Companion to `__VINEXT_SHARED_BUILD_ID`; never read by dev or
       * standalone code paths.
       */
      __VINEXT_SHARED_REVALIDATE_SECRET?: string;
      __VINEXT_PREVIEW_MODE_ID?: string;
      __VINEXT_PREVIEW_MODE_SIGNING_KEY?: string;
      __VINEXT_PREVIEW_MODE_ENCRYPTION_KEY?: string;

      /**
       * Deployment ID string injected via Vite `define` when
       * `NEXT_DEPLOYMENT_ID` is present at build time.
       */
      __VINEXT_DEPLOYMENT_ID?: string;

      /**
       * `"true"` when `next.config.js` enables
       * `experimental.prefetchInlining`.
       */
      __VINEXT_PREFETCH_INLINING?: string;

      /**
       * JSON-encoded array of `RemotePattern` objects from
       * `next.config.js` → `images.remotePatterns`.
       */
      __VINEXT_IMAGE_REMOTE_PATTERNS?: string;

      /**
       * JSON-encoded array of allowed hostname strings from
       * `next.config.js` → `images.domains` (legacy config).
       */
      __VINEXT_IMAGE_DOMAINS?: string;

      /**
       * JSON-encoded array of device width breakpoints (px) from
       * `next.config.js` → `images.deviceSizes`.
       */
      __VINEXT_IMAGE_DEVICE_SIZES?: string;

      /**
       * JSON-encoded array of image sizes (px) from
       * `next.config.js` → `images.sizes`.
       */
      __VINEXT_IMAGE_SIZES?: string;

      /**
       * `"true"` or `"false"` — whether SVG sources are allowed through the
       * image optimizer (`next.config.js` → `images.dangerouslyAllowSVG`).
       */
      __VINEXT_IMAGE_DANGEROUSLY_ALLOW_SVG?: string;

      /**
       * `"true"` or `"false"` — whether hostnames resolving to private IPs
       * are allowed (`next.config.js` → `images.dangerouslyAllowLocalIP`).
       */
      __VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP?: string;

      /**
       * Next.js-compatible version string. vinext mirrors Next.js's
       * `process.env.__NEXT_VERSION` define (from
       * `packages/next/src/client/next.ts` line 5) so library code that
       * reads it works unmodified. Value is the vinext package version,
       * injected by the plugin at build time.
       */
      __NEXT_VERSION?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// node:http augmentations — vinext properties added to IncomingMessage
// ---------------------------------------------------------------------------

declare module "node:http" {
  interface IncomingMessage {
    /**
     * The HTTP status code set by vinext middleware for Pages Router continue
     * or rewrite responses. Written in `index.ts` when middleware emits a
     * status override, read by the downstream Pages Router handler to decide
     * the final response status.
     */
    __vinextMiddlewareStatus?: number;
  }
}

// ---------------------------------------------------------------------------
// virtual:vinext-cache-adapters — generated cache-adapter registration module
// ---------------------------------------------------------------------------
//
// Generated by vinext at build time from the `cache` option in the vinext()
// plugin config. `registerConfiguredCacheAdapters(env)` registers the configured
// data / CDN cache adapters on first call and is a no-op when nothing is
// configured. See `cache/cache-adapters-virtual.ts` for the generator.

declare module "virtual:vinext-cache-adapters" {
  export function registerConfiguredCacheAdapters(env?: Record<string, unknown>): void;
}

declare module "virtual:vinext-pages-client-assets" {
  import type { PagesClientAssets } from "vinext/server/pages-client-assets";
  const assets: PagesClientAssets;
  export default assets;
}

// ---------------------------------------------------------------------------
// virtual:vinext-image-adapters — generated image-optimizer registration module
// ---------------------------------------------------------------------------
//
// Generated by vinext at build time from the `images` option in the vinext()
// plugin config. `registerConfiguredImageOptimizer(env)` registers the configured
// image optimizer (transform backend) on first call and is a no-op when nothing
// is configured. See `image/image-adapters-virtual.ts` for the generator.

declare module "virtual:vinext-image-adapters" {
  export function registerConfiguredImageOptimizer(env?: Record<string, unknown>): void;
}

// The `import type { Root }` at the top of this file makes it a TypeScript
// module (rather than a script), which is required for `declare global` blocks
// to act as global augmentations.
