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
 * `runDocumentRenderPage()` supplies `renderPage`, `defaultGetInitialProps`,
 * and the request pathname/query/asPath fields needed by the common upstream
 * pattern:
 *
 *   static async getInitialProps(ctx) {
 *     const initialProps = await Document.getInitialProps(ctx)
 *     return { ...initialProps, docValue }
 *   }
 *
 * The standalone `loadUserDocumentInitialProps()` compatibility path supplies
 * an empty default render result because it is only used after the body has
 * already been produced. Request-only fields such as req/res remain outside
 * that compatibility helper.
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
import React, { type ComponentType, type ReactNode } from "react";
import { withScriptNonce } from "vinext/shims/script-nonce-context";
// Static import so the identity comparison below is established once at
// module evaluation. A previous version used `await import(...)` per request
// and was flagged by reviewers as unnecessary work — and worse, it left a
// per-request `await` on the fast path where the user had no override.
import BaseDocument from "vinext/shims/document";
import { readStreamAsText } from "../utils/text-stream.js";

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

  // This compatibility path renders an already-produced body, so provide the
  // base Document delegation with an empty shell. The full Pages render path
  // uses `runDocumentRenderPage()` and supplies the real render callback.
  const result = await getInitialProps({
    defaultGetInitialProps: async () => ({ html: "" }),
  });
  return result && typeof result === "object" ? (result as Record<string, unknown>) : null;
}

/** Options accepted by a `ctx.renderPage()` call (Pages Router contract). */
export type RenderPageEnhancers = {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  enhanceApp?: (App: ComponentType<{ children?: ReactNode }>) => any;
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  enhanceComponent?: (Comp: ComponentType<unknown>) => any;
};

type RenderPageEnhancer =
  | RenderPageEnhancers
  | ((Comp: ComponentType<unknown>) => ComponentType<unknown>);

type DocumentInitialProps = {
  html: string;
  head?: ReactNode[];
  styles?: ReactNode;
};

type DocumentRenderPageInput = {
  /** The user `_document` component (may define `getInitialProps`). */
  DocumentComponent: ComponentType | null;
  /**
   * Build the page React tree with optional App/Component enhancers applied.
   * Callers MUST NOT apply `withScriptNonce` themselves — this helper owns the
   * nonce responsibility so the prod and dev paths stay symmetric.
   */
  enhancePageElement?: ((opts: RenderPageEnhancers) => ReactNode) | undefined;
  /** Render a React tree to a UTF-8 byte stream (prod/dev specific). */
  renderToReadableStream: (element: React.ReactElement) => Promise<ReadableStream<Uint8Array>>;
  /** Render the document `styles` element to an HTML string. */
  renderStylesToString: (element: React.ReactElement) => Promise<string>;
  /** Per-request CSP nonce applied to the enhanced page tree, if any. */
  scriptNonce?: string | undefined;
  /** Extra `DocumentContext` fields (pathname/query/asPath). */
  context?: Record<string, unknown> | undefined;
};

/**
 * Run a user `_document.getInitialProps()` with a `ctx.renderPage()` that
 * applies optional `enhanceApp` / `enhanceComponent` wrappers around the page
 * React tree, mirroring Next.js's Pages Router contract.
 *
 * Used by CSS-in-JS libraries (styled-components, emotion) to wrap the
 * App/Component tree so styles can be collected during SSR. Shared between the
 * prod (`pages-page-response.ts`) and dev (`dev-server.ts`) SSR pipelines so
 * the `getInitialProps` + `renderPage` contract lives in one place.
 *
 * @see .nextjs-ref/packages/next/src/server/render.tsx (search `renderPage`)
 *
 * Result of attempting the renderPage contract:
 *   - `skipped`  — `getInitialProps` was NOT invoked (no override, or no
 *                  `enhancePageElement` wired up). Callers should run the
 *                  normal `loadUserDocumentInitialProps` fast path, which may
 *                  invoke `getInitialProps` itself.
 *   - `rendered` — `renderPage` produced the body. `bodyHtml` is the rendered
 *                  page string, `stylesHTML` the rendered `styles`, `docProps`
 *                  the remaining props to spread onto `<Document>`, and `head`
 *                  the head nodes returned by `getInitialProps` (forward them to
 *                  `setDocumentInitialHead()` — do NOT call
 *                  `callDocumentGetInitialProps()` as well).
 */
type RunDocumentRenderPageResult =
  | { status: "skipped" }
  | {
      status: "rendered";
      bodyHtml: string;
      stylesHTML: string;
      docProps: Record<string, unknown>;
      head: ReactNode[];
    };

/**
 * Run a user `_document.getInitialProps()` with a `ctx.renderPage()` that
 * applies optional `enhanceApp` / `enhanceComponent` wrappers around the page
 * React tree, mirroring Next.js's Pages Router contract.
 *
 * Used by CSS-in-JS libraries (styled-components, emotion) to wrap the
 * App/Component tree so styles can be collected during SSR. Shared between the
 * prod (`pages-page-response.ts`) and dev (`dev-server.ts`) SSR pipelines so
 * the `getInitialProps` + `renderPage` contract lives in one place.
 *
 * `getInitialProps` is invoked at most once here. When this returns `rendered`,
 * callers MUST treat that as the single invocation and must not call
 * `loadUserDocumentInitialProps` again. Errors intentionally propagate to the
 * Pages Router's normal error-page pipeline, matching Next.js.
 *
 * @see .nextjs-ref/packages/next/src/server/render.tsx (search `renderPage`)
 */
export async function runDocumentRenderPage(
  input: DocumentRenderPageInput,
): Promise<RunDocumentRenderPageResult> {
  const DocCtor = input.DocumentComponent as
    | (ComponentType & {
        getInitialProps?: (ctx: unknown) => Promise<DocumentInitialProps>;
        displayName?: string;
      })
    | null;
  if (!DocCtor || typeof DocCtor.getInitialProps !== "function") return { status: "skipped" };
  // Identity check (mirrors `loadUserDocumentInitialProps`): if the user did
  // not override `static getInitialProps`, the inherited reference is the
  // shim's stub. Skip the renderPage work so the fast path stays cheap and the
  // caller falls through to the bare Document render.
  if (DocCtor.getInitialProps === BASE_GET_INITIAL_PROPS) return { status: "skipped" };
  if (!input.enhancePageElement) return { status: "skipped" };
  const enhancePageElement = input.enhancePageElement;

  const renderPage = async (
    opts: RenderPageEnhancer = {},
  ): Promise<{ html: string; head: ReactNode[] }> => {
    const enhancers: RenderPageEnhancers =
      typeof opts === "function" ? { enhanceComponent: opts } : opts;
    const enhancedElement = enhancePageElement(enhancers);
    // Nonce responsibility lives here so prod and dev produce identical
    // output — callers' `enhancePageElement` must not apply it themselves.
    const wrapped = withScriptNonce(enhancedElement as React.ReactElement, input.scriptNonce);
    const stream = await input.renderToReadableStream(wrapped);
    const html = await readStreamAsText(stream);
    return { html, head: [] };
  };

  const docInitialProps = await DocCtor.getInitialProps({
    // Pages renderers pass the request-scoped context they can provide
    // (pathname/query/asPath plus req/res when available). Subclasses that
    // forward to `ctx.renderPage` (the styled-components / emotion pattern)
    // also work through the defaultGetInitialProps helper below.
    renderPage,
    defaultGetInitialProps: async (ctx: { renderPage: typeof renderPage }) => {
      // Mirrors Next.js's `ctx.defaultGetInitialProps`: wrap App in an
      // identity enhancer so renderPage is still invoked even when a user
      // doesn't pass any enhancers themselves.
      const result = await ctx.renderPage({
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any
        enhanceApp: (App) => (props: any) => React.createElement(App, props),
      });
      return { html: result.html, head: result.head ?? [], styles: undefined };
    },
    ...input.context,
  });

  // Strip the contract fields the pipeline consumes itself so the rest can be
  // spread onto `<Document>` like Next.js does. `html` is the body; `head`/
  // `styles` are merged into the SSR head. `head` is surfaced back to the
  // caller so it can be folded into the dedupe pipeline via
  // `setDocumentInitialHead()` — `getInitialProps` is only ever invoked once
  // (here), so the standalone `callDocumentGetInitialProps()` path must not
  // run again for the same render.
  const { html: _html, head: rawHead, styles: _styles, ...docProps } = docInitialProps ?? {};
  const head: ReactNode[] = Array.isArray(rawHead) ? (rawHead as ReactNode[]) : [];

  if (!docInitialProps || typeof docInitialProps.html !== "string") {
    throw new Error(
      `"${DocCtor.displayName ?? DocCtor.name ?? "Document"}.getInitialProps()" should resolve to an object with a "html" prop set with a valid html string`,
    );
  }

  // Render `styles` returned by `getInitialProps()` (e.g. collected
  // styled-components / emotion <style> tags) to a string ready for the SSR
  // head. Matches Next.js's render.tsx where `styles` flows into the head.
  let stylesHTML = "";
  if (docInitialProps.styles != null) {
    stylesHTML = await input.renderStylesToString(
      React.createElement(React.Fragment, null, docInitialProps.styles),
    );
  }

  return { status: "rendered", bodyHtml: docInitialProps.html, stylesHTML, docProps, head };
}
