/**
 * Pages Router `_document.tsx` `getInitialProps` helper.
 *
 * Next.js's `pages/_document.tsx` may override
 * `static async getInitialProps(ctx)` to inject extra props onto the
 * Document element (the classic pattern is
 * `await Document.getInitialProps(ctx)` + spread, see Next.js's
 * `test/e2e/async-modules/pages/_document.jsx`). The SSR pipeline invokes
 * that hook and then renders the Document with the resolved props:
 *
 *   <Document {...htmlProps} {...docProps} />
 *
 * Reference:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx
 * (search for `loadDocumentInitialProps` and `documentElement`).
 *
 * vinext only forwards `docProps`. The full `DocumentContext`
 * (`renderPage`, `defaultGetInitialProps`, `pathname`, `query`, `req`, `res`,
 * `err`, `asPath`) is not yet plumbed through. The common upstream pattern
 *
 *   static async getInitialProps(ctx) {
 *     const initialProps = await Document.getInitialProps(ctx)
 *     return { ...initialProps, docValue }
 *   }
 *
 * works because the base `Document.getInitialProps` shim in
 * `shims/document.tsx` returns `{ html: "" }` and ignores `ctx`. User
 * overrides that *only* read `ctx` will see `undefined` fields — that is a
 * separate gap tracked alongside the shim TODO.
 *
 * Returns `null` when the user did not override the base shim (the static
 * `getInitialProps` reference still points at the shim's stub) so callers
 * skip the spread and render the bare Document element on the fast path.
 *
 * Errors from a user `getInitialProps` propagate to the caller. Next.js's
 * `loadGetInitialProps` does not catch — a throw becomes a 500 — and vinext
 * matches that contract so user bugs surface as the loud failures Next.js
 * apps already debug against.
 */
import type { ComponentType } from "react";
// Static import so the identity comparison below is established once at
// module evaluation. A previous version used `await import(...)` per request
// and was flagged by reviewers as unnecessary work — and worse, it left a
// per-request `await` on the fast path where the user had no override.
import BaseDocument from "vinext/shims/document";

const BASE_GET_INITIAL_PROPS = (
  BaseDocument as unknown as {
    getInitialProps?: unknown;
  }
).getInitialProps;

export async function loadUserDocumentInitialProps(
  DocumentComponent: ComponentType,
): Promise<Record<string, unknown> | null> {
  const getInitialProps = (
    DocumentComponent as unknown as {
      getInitialProps?: (
        ctx: unknown,
      ) => Promise<Record<string, unknown>> | Record<string, unknown>;
    }
  ).getInitialProps;
  if (typeof getInitialProps !== "function") return null;

  // Identity check: if the user did not override `static getInitialProps`,
  // the inherited reference is the shim's stub. Skip the call so the
  // fast path keeps the same number of awaits as before this helper landed.
  if (getInitialProps === BASE_GET_INITIAL_PROPS) return null;

  // Pass ctx as `{}`. Most upstream overrides only use ctx to delegate
  // back to `Document.getInitialProps`, which the shim ignores. Errors
  // propagate — matching Next.js's `loadGetInitialProps`, which has no
  // catch and surfaces user bugs as 500s.
  const result = await getInitialProps({});
  return result && typeof result === "object" ? (result as Record<string, unknown>) : null;
}
