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
type AppRouterPublicInstance = {
  push: (href: string, options?: { scroll?: boolean }) => void;
  replace: (href: string, options?: { scroll?: boolean }) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string, options?: { onInvalidate?: () => void }) => void;
  /** Default placeholder, matches Next.js. */
  bfcacheId?: string;
};

/**
 * Pages Router singleton surface — matches `NextRouter` from
 * `packages/next/src/shared/lib/router/router.ts` (line 372).
 *
 * Exported because `shims/router.ts` casts its strict `NextRouter` value
 * to this looser type at the install call site (Pages Router methods take
 * narrow `UrlObject | string` arguments, which are not contravariantly
 * assignable to the `unknown[]` surface this global exposes).
 *
 * `push` and `replace` return `Promise<boolean>` to match Next.js's
 * documented contract (`packages/next/src/shared/lib/router/router.ts:1025-1068`
 * — push/replace delegate to `change()` which returns `Promise<boolean>`,
 * resolving to `true` on a successful navigation and `false` when blocked
 * — e.g. hard-navigation fallback). The Next.js deploy test suite reads
 * the resolved value via `browser.eval('await window.next.router.push(...)')`
 * to assert success.
 */
export type PagesRouterPublicInstance = {
  push: (...args: unknown[]) => Promise<boolean>;
  replace: (...args: unknown[]) => Promise<boolean>;
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
// augmentation (which itself would have to import WindowNext from here).
// Matches the pattern Next.js uses in `packages/next/src/client/next.ts`
// lines 7-11:
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
 *
 * Not exported because all use is internal to this module — callers read
 * the shape off `window.next` directly, which inherits the augmentation
 * above without a named type import.
 */
type WindowNext = {
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

/**
 * Build-time replacement for the vinext package version, injected by the
 * Vite plugin via `define` (see `index.ts` — `process.env.__NEXT_VERSION`
 * is mirrored from `packages/vinext/package.json#version` so library
 * callers that read `process.env.__NEXT_VERSION` see a real value).
 *
 * In environments where the define did not run (standalone unit tests
 * that import this module without going through the plugin), the
 * `?? "vinext"` fallback prevents a literal `undefined` from landing on
 * `window.next.version`.
 */
const VINEXT_VERSION: string = process.env.__NEXT_VERSION ?? "vinext";

/**
 * Install `window.next` if it has not already been installed in this
 * document. Subsequent calls update fields in place so both the Pages
 * Router and the App Router bootstraps can call this without clobbering
 * each other (e.g. for hybrid `pages/` + `app/` setups).
 *
 * When called a second time, `router` and `appDir` overwrite the previous
 * values. This mirrors Next.js's load order: in a hybrid app the App
 * Router's `app-bootstrap.ts` runs after Pages Router's `next.ts` and the
 * App Router instance wins.
 *
 * No module-level cache: we read and write through `window.next` directly
 * so that a test (or userland code) that deletes `window.next` cleanly
 * resets state.
 */
export function installWindowNext(fields: Partial<WindowNext>): void {
  if (typeof window === "undefined") return;

  const existing = window.next;
  if (existing) {
    if (fields.version !== undefined) existing.version = fields.version;
    if (fields.appDir !== undefined) existing.appDir = fields.appDir;
    if (fields.router !== undefined) existing.router = fields.router;
    if (fields.__pendingUrl !== undefined) existing.__pendingUrl = fields.__pendingUrl;
    if (fields.__internal_src_page !== undefined) {
      existing.__internal_src_page = fields.__internal_src_page;
    }
    return;
  }

  window.next = {
    version: fields.version ?? VINEXT_VERSION,
    ...fields,
  };
}
