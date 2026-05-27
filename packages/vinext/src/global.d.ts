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
import type { CachedRscResponse, PrefetchCacheEntry } from "vinext/shims/navigation";

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
     * High-resolution timestamp recorded after client hydration is usable.
     * Pages Router writes after hydrateRoot() returns; App Router writes after
     * the first committed tree attaches browser router state.
     */
    __VINEXT_HYDRATED_AT: number | undefined;

    /**
     * Next.js test/runtime compatibility hydration marker.
     */
    __NEXT_HYDRATED: boolean | undefined;
    __NEXT_HYDRATED_AT: number | undefined;
    __NEXT_HYDRATED_CB: (() => void) | undefined;

    /**
     * The cached `_app` component for Pages Router.
     * Written and read by `shims/router.ts` to avoid re-importing on every
     * client-side navigation.
     */
    __VINEXT_APP__:
      | React.ComponentType<{
          Component: React.ComponentType<Record<string, unknown>>;
          pageProps: unknown;
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

  // ── globalThis globals — server-side / Cloudflare Workers ─────────────────
  //
  // These are injected into the Worker entry at build time by
  // `vinext:cloudflare-build`, or set at Node.js server startup by
  // `server/prod-server.ts`.  They are read during SSR by `collectAssetTags()`
  // in `index.ts`.

  /**
   * Vite SSR manifest injected into the Cloudflare Worker entry at build time.
   * Maps module file paths (relative to the project root) to the list of
   * associated JS / CSS asset filenames.
   * Read by `collectAssetTags()` to inject `<link rel="modulepreload">` and
   * `<link rel="stylesheet">` tags into the SSR HTML.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_SSR_MANIFEST__: Record<string, string[]> | undefined;

  /**
   * Array of chunk filenames that are only reachable via dynamic `import()`.
   * These chunks must NOT receive `<link rel="modulepreload">` tags because
   * they are fetched on demand (e.g. behind `React.lazy` / `next/dynamic`).
   * Injected into the Worker entry at build time; also set at Node.js server
   * startup by `server/prod-server.ts`.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_LAZY_CHUNKS__: string[] | undefined;

  /**
   * The client entry JS filename (e.g. `"_next/static/entry-abc123.js"`) for Pages
   * Router builds.
   * Injected into the Worker entry at build time for Pages Router only.
   * App Router uses the RSC plugin's `loadBootstrapScriptContent` mechanism
   * instead.
   */
  // oxlint-disable-next-line no-var
  var __VINEXT_CLIENT_ENTRY__: string | undefined;

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
       * Public App Router RSC compatibility identity injected via Vite
       * `define`. Used by browser navigation code to reject RSC payloads from
       * a different vinext build without exposing the raw build ID header.
       */
      __VINEXT_RSC_COMPATIBILITY_ID?: string;

      /**
       * Deployment ID string injected via Vite `define` when
       * `NEXT_DEPLOYMENT_ID` is present at build time.
       */
      __VINEXT_DEPLOYMENT_ID?: string;

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

// The `import type { Root }` at the top of this file makes it a TypeScript
// module (rather than a script), which is required for `declare global` blocks
// to act as global augmentations.
