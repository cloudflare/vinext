/**
 * next/error shim
 *
 * Provides the default Next.js error page component.
 * Used by apps that import `import Error from 'next/error'` for
 * custom error handling in getServerSideProps or API routes.
 *
 * Also re-exports the unstable App Router error-boundary HOC
 * (`unstable_catchError`) and its `ErrorInfo` type, mirroring
 * `next/error`'s public surface.
 */
import React from "react";
import { appRouterInstance, isNextRouterError } from "./navigation.js";
import { RouterContext } from "./internal/router-context.js";

type ErrorProps = {
  statusCode: number;
  title?: string;
  withDarkMode?: boolean;
};

function ErrorComponent({ statusCode, title }: ErrorProps): React.ReactElement {
  const defaultTitle =
    statusCode === 404 ? "This page could not be found" : "Internal Server Error";

  const displayTitle = title ?? defaultTitle;

  return React.createElement(
    "div",
    {
      style: {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        height: "100vh",
        textAlign: "center" as const,
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        justifyContent: "center",
      },
    },
    React.createElement(
      "div",
      null,
      React.createElement(
        "h1",
        {
          style: {
            display: "inline-block",
            margin: "0 20px 0 0",
            padding: "0 23px 0 0",
            fontSize: 24,
            fontWeight: 500,
            verticalAlign: "top",
            lineHeight: "49px",
            borderRight: "1px solid rgba(0, 0, 0, .3)",
          },
        },
        statusCode,
      ),
      React.createElement(
        "div",
        { style: { display: "inline-block" } },
        React.createElement(
          "h2",
          {
            style: {
              fontSize: 14,
              fontWeight: 400,
              lineHeight: "49px",
              margin: 0,
            },
          },
          displayTitle + ".",
        ),
      ),
    ),
  );
}

export default ErrorComponent;

// ---------------------------------------------------------------------------
// unstable_catchError — App Router error-boundary HOC
//
// `unstable_catchError(fallback)` returns a Component that renders `children`
// and, if the children throw, renders the user-supplied fallback with an
// `ErrorInfo` object. Internal Next.js navigation signals (redirect /
// notFound / forbidden / unauthorized) are rethrown so they reach the outer
// framework boundaries.
//
// Ported from Next.js:
//   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/catch-error.tsx
//   https://github.com/vercel/next.js/blob/canary/packages/next/src/api/error.ts
//   https://github.com/vercel/next.js/blob/canary/packages/next/src/api/error.react-server.ts
//
// Differences from Next.js:
//   - `unstable_retry()` matches Next.js's App Router behavior on the
//     client — it calls `appRouterInstance.refresh()` inside a
//     React.startTransition and then resets the boundary. On the server it
//     throws (consistent with React class components only running on the
//     server during SSR setup, where retry isn't meaningful). When the
//     boundary is rendered under the Pages Router (detected via
//     `RouterContext` in the wrapper), `unstable_retry()` throws Next.js's
//     verbatim error message (`unstable_retry() can only be used in the
//     App Router. Use reset() in the Pages Router.`) — matching
//     `client/components/catch-error.tsx` in the Next.js source and the
//     `should throw when unstable_retry is called on Pages Router` test in
//     `test/e2e/app-dir/catch-error/catch-error.test.ts`.
//   - Bot-user-agent graceful-degradation, `handleHardNavError`, and
//     `handleISRError` are not yet supported. Errors always render the
//     fallback in non-bot contexts.
//   - The single implementation runs in both react-server and client
//     conditions. In Next.js, the react-server build exports a throwing stub
//     because the API is documented as client-only. Here we let module
//     evaluation succeed everywhere so `import { unstable_catchError } from
//     'next/error'` does not break SSR-only bundles; misuse in a Server
//     Component still fails at render time because React class components
//     are unavailable in the react-server condition for this code path.
// ---------------------------------------------------------------------------

export type ErrorInfo = {
  error: unknown;
  reset: () => void;
  unstable_retry: () => void;
};

type _UserProps = Record<string, unknown>;

type _CatchErrorState = { thrownValue: unknown } | null;

class _CatchError<P extends _UserProps> extends React.Component<
  {
    fallback: (props: P, errorInfo: ErrorInfo) => React.ReactNode;
    forwardedProps: P;
    children?: React.ReactNode;
  },
  { error: _CatchErrorState }
> {
  // Read the Pages Router context via class `contextType` (matching Next.js's
  // pattern in `client/components/catch-error.tsx` which uses
  // `static contextType = AppRouterContext`). When `this.context` is non-null
  // we're rendered under a Pages Router page; `unstable_retry()` then throws
  // the Next.js parity error message. Using `contextType` rather than
  // `useContext` in the wrapper keeps the wrapper a pure JSX factory so
  // existing introspection-style unit tests (which invoke the wrapper as a
  // bare function to extract the inner class) continue to work without
  // React's render lifecycle.
  static contextType = RouterContext;
  declare context: React.ContextType<typeof RouterContext>;

  // Match Next.js's DevTools label so userland tooling/snapshots align.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/catch-error.tsx
  static displayName = "unstable_catchError(Next.CatchError)";

  state = { error: null as _CatchErrorState };

  static getDerivedStateFromError(thrownValue: unknown): { error: _CatchErrorState } {
    if (isNextRouterError(thrownValue)) {
      // Re-throw redirect/notFound/etc. so an outer framework boundary handles
      // them. Matches Next.js's CatchError.getDerivedStateFromError().
      throw thrownValue;
    }
    return { error: { thrownValue } };
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  unstable_retry = (): void => {
    // Pages Router has no segment-refresh primitive — Next.js documents
    // `unstable_retry` as App Router only and throws this exact message
    // from the boundary itself. Mirrors
    // packages/next/src/client/components/catch-error.tsx and is asserted
    // by `should throw when unstable_retry is called on Pages Router` in
    // test/e2e/app-dir/catch-error/catch-error.test.ts.
    //
    // `RouterContext` is populated for every page rendered by the vinext
    // Pages Router runtime (see `shims/router.ts` wrapWithRouterContext); a
    // non-null value here means we're under Pages Router. Under App Router
    // the context default is `null` and we fall through to the refresh
    // branch below.
    if (this.context !== null) {
      throw new Error(
        "`unstable_retry()` can only be used in the App Router. Use `reset()` in the Pages Router.",
      );
    }
    // Matches Next.js's App Router branch in
    // packages/next/src/client/components/catch-error.tsx — refresh the
    // current route, then clear the error so children re-render. Wrapped in
    // startTransition so the in-flight refresh and the reset commit
    // together (no flash of the children rendering with stale data).
    //
    // On the server, refresh is meaningless and `appRouterInstance.refresh`
    // is a no-op; throw a clear error so callers don't silently swallow a
    // retry attempt during SSR setup. Matches the spirit of Next.js's
    // server-side throw (which lives in error-boundary.tsx, not here).
    if (typeof window === "undefined") {
      throw new Error(
        "`unstable_retry()` can only be used on the client. Call it from a user " +
          "interaction handler inside the error fallback.",
      );
    }
    React.startTransition(() => {
      appRouterInstance.refresh();
      this.reset();
    });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      const errorInfo: ErrorInfo = {
        error: this.state.error.thrownValue,
        reset: this.reset,
        unstable_retry: this.unstable_retry,
      };
      return this.props.fallback(this.props.forwardedProps, errorInfo);
    }
    return this.props.children;
  }
}

/**
 * Wrap a fallback render function in a Component-level error boundary.
 * Returns a Component that renders `children` and, on error, renders the
 * supplied fallback with an `ErrorInfo` value.
 *
 * Ported from Next.js:
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/catch-error.tsx
 */
export function unstable_catchError<P extends _UserProps>(
  fallback: (props: P, errorInfo: ErrorInfo) => React.ReactNode,
): React.ComponentType<P & { children?: React.ReactNode }> {
  // The inner class is generic in P, but createElement loses that generic at
  // the call site. Cast it to a non-generic constructor for the specific P
  // we close over here so TypeScript can pick the JSX-style createElement
  // overload without complaining about missing generic instantiation.
  const TypedCatchError = _CatchError as unknown as React.ComponentType<{
    fallback: (props: P, errorInfo: ErrorInfo) => React.ReactNode;
    forwardedProps: P;
    children?: React.ReactNode;
  }>;

  function CatchErrorBoundary(allProps: P & { children?: React.ReactNode }): React.ReactElement {
    const { children, ...rest } = allProps;
    const forwardedProps = rest as unknown as P;
    return React.createElement(
      TypedCatchError,
      { fallback, forwardedProps },
      children as React.ReactNode,
    );
  }
  CatchErrorBoundary.displayName = `unstable_catchError(${fallback.name || "CatchErrorFallback"})`;
  return CatchErrorBoundary;
}
