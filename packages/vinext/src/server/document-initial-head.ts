/**
 * Shared helper: invoke a user-defined `_document.getInitialProps()` and feed
 * any returned head tags into the shared dedupe pipeline via
 * `setDocumentInitialHead()`.
 *
 * Both the dev-server streaming path (`server/dev-server.ts`) and the unified
 * Pages Router response path (`server/pages-page-response.ts`) need the exact
 * same behavior — constructing the minimal `DocumentContext`, awaiting the
 * call inside a try/catch, defensively unwrapping `head`. Living here keeps
 * the contract in one place and lets the (mostly-static) implementation be
 * tested in isolation.
 *
 * The behaviour mirrors Next.js's `_document` contract:
 * - skip the call entirely when the resolved `DocumentComponent` is null
 *   (no user `_document.tsx`)
 * - skip the call when the resolved `getInitialProps` is the unmodified
 *   default inherited from vinext's `next/document` shim — that default
 *   returns `{ html: "" }` and `head` is always `undefined`, so calling it
 *   is wasted work on every render for apps that don't customise it.
 * - otherwise: await, defensively normalise the result, forward the head
 *   array to the shim.
 *
 * Errors are logged but never thrown — a buggy `_document.getInitialProps`
 * must not take the whole response down. Matches Next.js's runtime, which
 * treats `_document` failures as non-fatal head merges.
 */
import type React from "react";
import Document, { type DocumentContext } from "vinext/shims/document";

/**
 * Reference to the unmodified `Document.getInitialProps` static. Used to
 * detect when a user `_document.tsx` did NOT override the method (i.e. they
 * extend `Document` but only redefine `render`), so we can skip the call.
 *
 * Captured via an indexed access (`Document["getInitialProps"]`) rather than
 * a dotted access so oxlint's `unbound-method` rule doesn't flag this as a
 * possible `this` escape — `getInitialProps` is a static method with no
 * `this` dependency, so capturing the function reference is safe.
 */
const DEFAULT_GET_INITIAL_PROPS: unknown = Document["getInitialProps"];

type DocumentLike = {
  // oxlint-disable-next-line typescript/no-explicit-any
  getInitialProps?: (ctx: DocumentContext) => Promise<{ head?: unknown } | undefined>;
};

export async function callDocumentGetInitialProps(
  DocumentComponent: React.ComponentType | null | undefined,
  setDocumentInitialHead: ((head: React.ReactNode[]) => void) | undefined,
): Promise<void> {
  if (!DocumentComponent || !setDocumentInitialHead) return;

  const DocCtor = DocumentComponent as unknown as DocumentLike;
  const getInitialProps = DocCtor.getInitialProps;

  // Skip when the component does not expose `getInitialProps` at all, or
  // when it still resolves to the default inherited from vinext's shim.
  // Comparing against the captured `DEFAULT_GET_INITIAL_PROPS` reference is
  // what distinguishes a user override from the default — extending the
  // shim's `Document` without overriding inherits the same static function.
  if (typeof getInitialProps !== "function" || getInitialProps === DEFAULT_GET_INITIAL_PROPS) {
    return;
  }

  try {
    const initialProps = await getInitialProps({
      // Minimal DocumentContext — vinext does not yet plumb the full context
      // (req/res/renderPage/defaultGetInitialProps) for SSR. User code that
      // relies on those fields receives no-op stand-ins; matches the
      // documented limitation in `shims/document.tsx`.
      defaultGetInitialProps: async () => ({ html: "", head: [], styles: undefined }),
      renderPage: () => ({ html: "" }),
    });
    const initialHead = Array.isArray(initialProps?.head)
      ? (initialProps.head as React.ReactNode[])
      : [];
    setDocumentInitialHead(initialHead);
  } catch (err) {
    console.error("[vinext] _document.getInitialProps() threw:", err);
  }
}
