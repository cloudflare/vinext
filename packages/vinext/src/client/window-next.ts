/**
 * Install the `window.next` debug/diagnostic global that Next.js exposes
 * on the client.
 *
 * Next.js publishes a small per-app object on `window.next` from its
 * client bootstraps and uses it for two distinct purposes:
 *
 *   1. An external debugging / test-automation surface. Pages Router tests
 *      and userland code routinely call `window.next.router.push(...)` and
 *      `window.next.router.events.on(...)` directly, and the App Router
 *      bootstrap sets `appDir: true` so consumers can branch on which
 *      router is active.
 *      - Pages Router: `packages/next/src/client/next.ts`
 *      - App Router: `packages/next/src/client/app-bootstrap.ts`
 *      - App Router public surface:
 *        `packages/next/src/client/components/app-router-instance.ts`
 *        (`window.next.router = publicAppRouterInstance` at line 510)
 *
 *   2. Internal navigation bookkeeping read by Next.js itself. The App
 *      Router's <Router> component writes `window.next.__internal_src_page`
 *      whenever the active source-page changes, and the router instance
 *      writes `window.next.__pendingUrl` at the start of a programmatic
 *      navigation so nav-failure-handler.ts can fall back to a hard
 *      navigation if a render fails.
 *      - `packages/next/src/client/components/app-router.tsx` (line ~204)
 *      - `packages/next/src/client/components/app-router-instance.ts`
 *        (line ~296)
 *      - `packages/next/src/client/components/nav-failure-handler.ts`
 *
 * Without this global, third-party libraries and a large fraction of the
 * Next.js deploy test suite crash with
 * `TypeError: Cannot read properties of undefined (reading 'router')`.
 *
 * Both routers in vinext share this installer so the field shape stays in
 * sync and only one source of truth describes the supported keys.
 */

/**
 * The minimum App Router public router surface that Next.js exposes on
 * `window.next.router`. Mirrors the `publicAppRouterInstance` shape from
 * `packages/next/src/client/components/app-router-instance.ts`.
 *
 * `hmrRefresh` and `experimental_gesturePush` are intentionally omitted —
 * vinext does not implement them. Library callers that branch on their
 * presence (`typeof router.hmrRefresh === "function"`) will skip the
 * branch, matching what they would do on a production Next.js build.
 */
export type AppRouterPublicInstance = {
  push: (href: string, options?: { scroll?: boolean }) => void;
  replace: (href: string, options?: { scroll?: boolean }) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => void;
  /** Default placeholder, matches Next.js. */
  bfcacheId?: string;
};

/**
 * Pages Router singleton surface — matches `NextRouter` from
 * `packages/next/src/shared/lib/router/router.ts` (line 372).
 *
 * Typed loosely here because the helper is consumed by both the pages
 * router shim (which exports the strict `NextRouter` type) and tests that
 * only care about the runtime shape. The structural fields below are the
 * subset that downstream callers (Next.js tests, third-party libs) read
 * synchronously off `window.next.router`.
 */
export type PagesRouterPublicInstance = {
  push: (...args: unknown[]) => unknown;
  replace: (...args: unknown[]) => unknown;
  back: () => void;
  reload: () => void;
  prefetch: (...args: unknown[]) => unknown;
  beforePopState: (cb: (...args: unknown[]) => boolean) => void;
  events: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
    emit: (event: string, ...args: unknown[]) => void;
  };
};

// Declare the `next` property on Window here, alongside the type, so this
// module type-checks standalone without depending on the global.d.ts
// augmentation (which itself imports WindowNext from this file). Matches the
// pattern Next.js uses in `packages/next/src/client/next.ts` lines 7-11:
//   declare global { interface Window { next: any } }
declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Window {
    next?: WindowNext;
  }
}

/**
 * The shape of `window.next`. Only includes fields vinext actually
 * implements. App Router additionally writes `__internal_src_page` and
 * `__pendingUrl` at runtime; they start undefined.
 */
export type WindowNext = {
  /**
   * Version string, mirroring Next.js's `process.env.__NEXT_VERSION` set
   * from `packages/next/src/client/next.ts` (line 5). vinext substitutes
   * the vinext package version because there is no underlying Next.js
   * runtime to report.
   */
  version: string;
  /**
   * `true` when the App Router bootstrap has run on this page. Matches
   * Next.js `app-bootstrap.ts` (line 15: `appDir: true`). Pages Router
   * leaves this undefined.
   */
  appDir?: boolean;
  /**
   * The active router instance. App Router writes the publicAppRouterInstance
   * here; Pages Router writes its Router singleton. Same property name in
   * both Next.js and vinext.
   */
  router?: AppRouterPublicInstance | PagesRouterPublicInstance;
  /**
   * App Router only. The URL of the current in-flight navigation (set when
   * a navigation begins, cleared on commit). Read by
   * `nav-failure-handler.ts` to fall back to a hard navigation when a
   * render fails. Pages Router does not write this.
   */
  __pendingUrl?: URL;
  /**
   * App Router only. The source page extracted from the current Flight
   * router state. Read by external tooling and Next.js's own dev hot
   * reloader. Pages Router does not write this.
   */
  __internal_src_page?: string;
};

const FALLBACK_VERSION = "vinext";

let installedNext: WindowNext | null = null;

/**
 * Install `window.next` if it has not already been installed in this
 * document. Subsequent calls return the existing object so both the
 * Pages and App Router entries can call this without clobbering each
 * other (e.g. in app/(pages-and-app)/ hybrid setups).
 *
 * Updates existing fields when called a second time so that whichever
 * router bootstraps last (typically App Router for hybrid setups) wins
 * for `router` and `appDir`. This mirrors Next.js's order: when both
 * routers are present, the App Router's `app-bootstrap.ts` runs after
 * `next.ts` and overwrites `window.next.router`.
 */
export function installWindowNext(fields: Partial<WindowNext>): WindowNext {
  if (typeof window === "undefined") {
    // SSR: nothing to do. Returning an empty object keeps the call signature
    // total without requiring callers to wrap each call in `if (window)`.
    return { version: fields.version ?? FALLBACK_VERSION, ...fields };
  }

  const existing = window.next ?? installedNext;
  if (existing) {
    if (fields.version !== undefined) existing.version = fields.version;
    if (fields.appDir !== undefined) existing.appDir = fields.appDir;
    if (fields.router !== undefined) existing.router = fields.router;
    if (fields.__pendingUrl !== undefined) existing.__pendingUrl = fields.__pendingUrl;
    if (fields.__internal_src_page !== undefined) {
      existing.__internal_src_page = fields.__internal_src_page;
    }
    window.next = existing;
    installedNext = existing;
    return existing;
  }

  const next: WindowNext = {
    version: fields.version ?? FALLBACK_VERSION,
    ...fields,
  };
  window.next = next;
  installedNext = next;
  return next;
}

/**
 * Read `window.next`, returning null when the document is server-rendered
 * or hydration has not yet installed it. Exposed for tests and for the App
 * Router's per-navigation writes to `__pendingUrl` / `__internal_src_page`.
 */
export function getWindowNext(): WindowNext | null {
  if (typeof window === "undefined") return null;
  return window.next ?? null;
}
