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
 * Returns `null` when:
 *   - The Document has no `getInitialProps` (unusual — the shim defines one),
 *   - The user did not override the base shim (so the call would be a no-op),
 *   - The override threw (logged and swallowed; matches Next.js's tolerant
 *     behaviour around document props).
 *
 * Callers should treat `null` as "render the bare Document element" so the
 * fast-path stays an extra zero allocations.
 */
import type { ComponentType } from "react";

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

  // Detect "user didn't override the base shim" so we don't allocate on the
  // hot path for every render. If the shim resolution fails (production
  // bundling can rewrite paths) we still invoke whatever's present —
  // the base shim itself is a cheap `Promise.resolve({ html: "" })`.
  let baseGetInitialProps: unknown = null;
  try {
    const docMod = (await import("vinext/shims/document")) as {
      default?: { getInitialProps?: unknown };
    };
    baseGetInitialProps = docMod.default?.getInitialProps ?? null;
  } catch {
    // shim resolution failed — fall through.
  }
  if (baseGetInitialProps && getInitialProps === baseGetInitialProps) return null;

  try {
    const result = await getInitialProps({});
    return result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  } catch (err) {
    // Surface but don't fail the render: Next.js logs and continues without
    // doc props when the user's getInitialProps throws.
    console.error("[vinext] Document.getInitialProps threw:", err);
    return null;
  }
}
