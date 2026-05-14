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
import { isNextRouterError } from "./navigation.js";

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
//   - We do not implement `unstable_retry` (requires the App Router instance
//     context, which vinext doesn't currently thread through error boundaries).
//     It is exposed on `ErrorInfo` as a no-op that throws a clear error so
//     misuse fails loudly rather than silently. Tracked as a follow-up.
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
    // vinext does not yet expose a refresh handle through this boundary.
    // Throwing a clear error is better than a silent no-op; tracked as a
    // follow-up so users discover the gap immediately.
    throw new Error(
      "`unstable_retry()` is not yet implemented by vinext's `unstable_catchError`. " +
        "Use `reset()` for now.",
    );
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
