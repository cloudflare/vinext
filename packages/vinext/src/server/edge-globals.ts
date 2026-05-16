/**
 * Installs globals that Next.js's edge runtime exposes to user code, so the
 * same code runs on vinext without explicit `import`s.
 *
 * Next.js's edge sandbox stitches a number of Node and Web APIs onto the
 * runtime's global context. vinext executes user code directly on the
 * Cloudflare Workers runtime (no separate sandbox), so any global that the
 * Workers runtime does not already provide must be installed here.
 *
 * Currently installed:
 *
 *   - `AsyncLocalStorage` — Workers exposes it only via
 *     `import { AsyncLocalStorage } from "node:async_hooks"` under the
 *     `nodejs_compat` flag, but Next.js's edge sandbox installs it as a
 *     global (`packages/next/src/server/web/sandbox/context.ts`:
 *     `context.AsyncLocalStorage = AsyncLocalStorage`). User code written
 *     for the edge runtime does `new AsyncLocalStorage()` with no import.
 *
 * Intentionally NOT installed:
 *
 *   - `URLPattern` — Cloudflare Workers expose it natively, and our CI
 *     pins Node 24+ which also exposes it as a global. No polyfill needed.
 *
 * This helper is idempotent and safe to call from every runtime entry point
 * that might evaluate user edge code (middleware, App Router route handlers,
 * Pages API routes).
 */
import { AsyncLocalStorage } from "node:async_hooks";

type GlobalWithEdgeAdditions = typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};

export function installEdgeGlobals(): void {
  const g = globalThis as GlobalWithEdgeAdditions;
  if (typeof g.AsyncLocalStorage === "undefined") {
    g.AsyncLocalStorage = AsyncLocalStorage;
  }
}
