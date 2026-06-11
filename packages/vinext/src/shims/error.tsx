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
import { isNextRouterError, usePathname } from "./navigation.js";
import { AppRouterContext, type AppRouterInstance } from "./internal/app-router-context.js";
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
type _CatchErrorProps<P extends _UserProps> = {
  children?: React.ReactNode;
  fallback: React.ComponentType<{
    props: P;
    errorInfo: ErrorInfo;
  }>;
  isPagesRouter: boolean;
  pathname: string | null;
  props: P;
};

type _CatchErrorInternalState = {
  error: _CatchErrorState;
  previousPathname: string | null;
};

const _CatchErrorAppRouterContext =
  AppRouterContext ?? React.createContext<AppRouterInstance | null>(null);

class _CatchError<P extends _UserProps> extends React.Component<
  _CatchErrorProps<P>,
  _CatchErrorInternalState
> {
  static contextType = _CatchErrorAppRouterContext;
  declare context: AppRouterInstance | null;

  // Match Next.js's DevTools label so userland tooling/snapshots align.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/catch-error.tsx
  static displayName = "unstable_catchError(Next.CatchError)";

  constructor(props: _CatchErrorProps<P>) {
    super(props);
    this.state = {
      error: null,
      previousPathname: props.pathname,
    };
  }

  static getDerivedStateFromError(thrownValue: unknown): { error: _CatchErrorState } {
    if (isNextRouterError(thrownValue)) {
      // Re-throw redirect/notFound/etc. so an outer framework boundary handles
      // them. Matches Next.js's CatchError.getDerivedStateFromError().
      throw thrownValue;
    }
    return { error: { thrownValue } };
  }

  static getDerivedStateFromProps(
    props: Pick<_CatchErrorProps<_UserProps>, "pathname">,
    state: _CatchErrorInternalState,
  ): _CatchErrorInternalState {
    if (props.pathname !== state.previousPathname && state.error) {
      return {
        error: null,
        previousPathname: props.pathname,
      };
    }
    return {
      error: state.error,
      previousPathname: props.pathname,
    };
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
    if (this.props.isPagesRouter) {
      throw new Error(
        "`unstable_retry()` can only be used in the App Router. Use `reset()` in the Pages Router.",
      );
    }
    // Matches Next.js's App Router branch in
    // packages/next/src/client/components/catch-error.tsx — refresh the
    // current route, then clear the error so children re-render. Wrapped in
    // startTransition so the in-flight refresh and the reset commit
    // together (no flash of the children rendering with stale data).
    React.startTransition(() => {
      this.context?.refresh();
      this.reset();
    });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      const Fallback = this.props.fallback;
      const errorInfo: ErrorInfo = {
        error: this.state.error.thrownValue,
        reset: this.reset,
        unstable_retry: this.unstable_retry,
      };
      return React.createElement(Fallback, { props: this.props.props, errorInfo });
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
  const Fallback = ({ props, errorInfo }: { props: P; errorInfo: ErrorInfo }): React.ReactNode =>
    fallback(props, errorInfo);

  Fallback.displayName = fallback.name || "CatchErrorFallback";

  function CatchErrorBoundary(allProps: P & { children?: React.ReactNode }): React.ReactElement {
    const { children, ...rest } = allProps;
    const pathname = usePathname();
    const isPagesRouter = React.useContext(RouterContext) !== null;
    // Boundary assertion: React's prop rest type is `Omit<P & { children?: ... }, "children">`;
    // by construction `children` is the only key removed, so the remaining
    // object is the user prop bag P that Next passes to the fallback.
    const forwardedProps = rest as P;
    return React.createElement(
      _CatchError<P>,
      {
        fallback: Fallback,
        isPagesRouter,
        pathname,
        props: forwardedProps,
      },
      children as React.ReactNode,
    );
  }
  CatchErrorBoundary.displayName = `unstable_catchError(${fallback.name || "CatchErrorFallback"})`;
  return CatchErrorBoundary;
}
