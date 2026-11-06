/**
 * Marks the work that Next.js runs with a work store (`workAsyncStorage`):
 * App Router renders, Server Actions, route handlers and metadata routes,
 * `generateStaticParams`, and middleware. Pages Router renders, API routes
 * and `getStaticPaths` run without one.
 *
 * Next.js only applies some rules inside a work store, such as skipping the
 * read for an `unstable_cache` nested in another's callback.
 * Source: https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/spec-extension/unstable-cache.ts
 */
import { getOrCreateAls } from "./als-registry.js";

const _workStoreScopeAls = getOrCreateAls<boolean>("vinext.workStoreScope.als");

export function runInWorkStoreScope<T>(fn: () => T): T {
  return _workStoreScopeAls.run(true, fn);
}

export function runOutsideWorkStoreScope<T>(fn: () => T): T {
  return _workStoreScopeAls.run(false, fn);
}

export function isInsideWorkStoreScope(): boolean {
  return _workStoreScopeAls.getStore() === true;
}
