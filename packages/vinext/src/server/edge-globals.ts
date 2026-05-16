/**
 * Globals exposed by the Next.js edge runtime that user code is allowed to
 * reference without an explicit `import`.
 *
 * Next.js's edge sandbox stitches a number of Node and Web APIs onto the
 * runtime's global context. vinext executes user code directly on the
 * Cloudflare Workers runtime (no separate sandbox), and Workers does not
 * expose `AsyncLocalStorage` as a global — it is only available via
 * `import { AsyncLocalStorage } from "node:async_hooks"` under the
 * `nodejs_compat` flag.
 *
 * User code written for Next.js's edge runtime can do
 *
 *     const storage = new AsyncLocalStorage()
 *
 * without importing it. To preserve that surface on vinext we install
 * `AsyncLocalStorage` on `globalThis` (idempotently) from any runtime entry
 * point that might evaluate user edge code: middleware, App Router route
 * handlers, and Pages API routes.
 *
 * Reference (Next.js edge sandbox):
 *   packages/next/src/server/web/sandbox/context.ts
 *     context.AsyncLocalStorage = AsyncLocalStorage
 *
 * TODO(edge-globals): A `URLPattern` change is being worked on in parallel.
 * Once both land, consider consolidating these into a single
 * `installEdgeGlobals()` helper called from a shared bootstrap.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type GlobalWithEdgeAdditions = typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};

const _g = globalThis as GlobalWithEdgeAdditions;

if (typeof _g.AsyncLocalStorage === "undefined") {
  _g.AsyncLocalStorage = AsyncLocalStorage;
}
