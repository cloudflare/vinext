/**
 * next/dynamic shim
 *
 * SSR-safe dynamic imports. On the server, uses React.lazy + Suspense so that
 * renderToReadableStream suspends until the dynamically-imported component is
 * available. On the client, also uses React.lazy for code splitting.
 *
 * Works in RSC, SSR, and client environments:
 * - RSC: Uses React.lazy + Suspense (available in React 19.x react-server).
 *   Falls back to async component pattern if a future React version
 *   strips lazy from react-server.
 * - SSR: React.lazy + Suspense (renderToReadableStream suspends)
 * - Client: React.lazy + Suspense (standard code splitting)
 *
 * Supports:
 * - dynamic(import('./Component'))
 * - dynamic(() => import('./Component'))
 * - dynamic({ loader })
 * - dynamic(() => import('./Component'), { loading: () => <Spinner /> })
 * - dynamic(() => import('./Component'), { ssr: false })
 */
import React, { type ComponentType } from "react";

type DynamicLoadingProps = {
  error?: Error | null;
  isLoading?: boolean;
  pastDelay?: boolean;
  retry?: () => void;
  timedOut?: boolean;
};

type ComponentModule<P> = { default: ComponentType<P> };
type LoaderComponent<P> = Promise<ComponentModule<P> | ComponentType<P>>;
type LoaderFn<P> = () => LoaderComponent<P>;

type DynamicOptions<P> = {
  loading?: ComponentType<DynamicLoadingProps>;
  loader?: Loader<P>;
  ssr?: boolean;
};

type Loader<P> = LoaderFn<P> | LoaderComponent<P>;
type DynamicInput<P> = DynamicOptions<P> | Loader<P>;

const noopRetry = () => {};

function createDynamicLoadingProps(
  overrides: Partial<DynamicLoadingProps> = {},
): DynamicLoadingProps {
  return {
    error: null,
    isLoading: true,
    pastDelay: true,
    retry: noopRetry,
    timedOut: false,
    ...overrides,
  };
}

function hasDefaultExport<P>(
  mod: ComponentModule<P> | ComponentType<P>,
): mod is ComponentModule<P> {
  return (typeof mod === "object" || typeof mod === "function") && mod !== null && "default" in mod;
}

function normalizeLoader<P extends object>(loader: Loader<P>): LoaderFn<P> {
  if (typeof loader === "function") {
    return loader;
  }
  return () => loader;
}

function normalizeDynamicOptions<P extends object>(
  dynamicInput: DynamicInput<P>,
  options?: DynamicOptions<P>,
): DynamicOptions<P> {
  let normalizedOptions: DynamicOptions<P>;

  if (dynamicInput instanceof Promise || typeof dynamicInput === "function") {
    normalizedOptions = { loader: normalizeLoader(dynamicInput) };
  } else {
    normalizedOptions = dynamicInput;
  }

  return {
    ...normalizedOptions,
    ...options,
  };
}

function createLazyComponent<P extends object>(loader: LoaderFn<P>) {
  return React.lazy(async () => {
    const mod = await loader();
    if (hasDefaultExport(mod)) return mod;
    return { default: mod };
  });
}

function useRetryableLazyComponent<P extends object>(
  loader: LoaderFn<P>,
  initialLazyComponent: ReturnType<typeof createLazyComponent<P>>,
) {
  const [LazyComponent, setLazyComponent] = React.useState(() => initialLazyComponent);
  const [retryKey, setRetryKey] = React.useState(0);
  const retry = React.useCallback(() => {
    setLazyComponent(() => createLazyComponent(loader));
    setRetryKey((key) => key + 1);
  }, [loader]);
  return { LazyComponent, retry, retryKey };
}

type DynamicErrorBoundaryProps = {
  fallback: ComponentType<DynamicLoadingProps>;
  retry: () => void;
  resetKey: number;
  children?: React.ReactNode;
};

type DynamicErrorBoundaryState = {
  error: Error | null;
  resetKey: number;
};

/**
 * Lightweight error boundary that renders the loading component with the error
 * when a dynamic() loader rejects. Without this, loader failures would propagate
 * uncaught through React's rendering — this preserves the Next.js behavior where
 * the `loading` component can display errors.
 *
 * Lazily created because React.Component is not available in the RSC environment
 * (server components use a slimmed-down React that doesn't include class components).
 */
let DynamicErrorBoundary: ComponentType<DynamicErrorBoundaryProps> | null | undefined;
function getDynamicErrorBoundary() {
  if (DynamicErrorBoundary) return DynamicErrorBoundary;
  if (!React.Component) return null;
  DynamicErrorBoundary = class extends (
    React.Component<DynamicErrorBoundaryProps, DynamicErrorBoundaryState>
  ) {
    constructor(props: DynamicErrorBoundaryProps) {
      super(props);
      this.state = { error: null, resetKey: props.resetKey };
    }
    static getDerivedStateFromProps(
      props: DynamicErrorBoundaryProps,
      state: DynamicErrorBoundaryState,
    ) {
      if (props.resetKey !== state.resetKey) {
        return { error: null, resetKey: props.resetKey };
      }
      return null;
    }
    static getDerivedStateFromError(error: unknown) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
    render() {
      if (this.state.error) {
        return React.createElement(
          this.props.fallback,
          createDynamicLoadingProps({
            isLoading: false,
            error: this.state.error,
            retry: this.props.retry,
          }),
        );
      }
      return this.props.children;
    }
  };
  return DynamicErrorBoundary;
}

// Detect server vs client
const isServer = typeof window === "undefined";

// Legacy preload queue — kept for backward compatibility with Pages Router
// which calls flushPreloads() before rendering. The App Router uses React.lazy
// + Suspense instead, so this queue is no longer populated.
const preloadQueue: Promise<void>[] = [];

/**
 * Wait for all pending dynamic() preloads to resolve, then clear the queue.
 * Called by the Pages Router SSR handler before rendering.
 * No-op for the App Router path which uses React.lazy + Suspense.
 */
export function flushPreloads(): Promise<void[]> {
  const pending = preloadQueue.splice(0);
  return Promise.all(pending);
}

function dynamic<P extends object = object>(
  dynamicInput: DynamicInput<P>,
  options?: DynamicOptions<P>,
): ComponentType<P> {
  const {
    loader: dynamicLoader,
    loading: LoadingComponent,
    ssr = true,
  } = normalizeDynamicOptions(dynamicInput, options);
  const loader = dynamicLoader ? normalizeLoader(dynamicLoader) : () => Promise.resolve(() => null);

  // ssr: false — render nothing on the server, lazy-load on client
  if (!ssr) {
    if (isServer) {
      // On the server (SSR or RSC), just render the loading state or nothing
      const SSRFalse = (_props: P) =>
        LoadingComponent
          ? React.createElement(LoadingComponent, createDynamicLoadingProps({ pastDelay: false }))
          : null;
      SSRFalse.displayName = "DynamicSSRFalse";
      return SSRFalse;
    }

    const InitialLazyComponent = createLazyComponent(loader);

    const ClientSSRFalse = (props: P) => {
      const [mounted, setMounted] = React.useState(false);
      const { LazyComponent, retry, retryKey } = useRetryableLazyComponent(
        loader,
        InitialLazyComponent,
      );
      React.useEffect(() => setMounted(true), []);

      if (!mounted) {
        return LoadingComponent
          ? React.createElement(LoadingComponent, createDynamicLoadingProps({ retry }))
          : null;
      }

      const fallback = LoadingComponent
        ? React.createElement(LoadingComponent, createDynamicLoadingProps({ retry }))
        : null;
      const lazyElement = React.createElement(LazyComponent, props);
      let content: React.ReactNode = lazyElement;
      if (LoadingComponent) {
        const ErrorBoundary = getDynamicErrorBoundary();
        if (ErrorBoundary) {
          content = React.createElement(
            ErrorBoundary,
            { fallback: LoadingComponent, retry, resetKey: retryKey },
            lazyElement,
          );
        }
      }
      return React.createElement(React.Suspense, { fallback }, content);
    };

    ClientSSRFalse.displayName = "DynamicClientSSRFalse";
    return ClientSSRFalse;
  }

  // SSR-enabled path
  if (isServer) {
    // Defensive fallback: if a future React version strips React.lazy from the
    // react-server condition, fall back to an async component pattern.
    // In React 19.x, React.lazy IS available in react-server, so this branch
    // does not execute — it exists for forward compatibility only.
    if (typeof React.lazy !== "function") {
      const AsyncServerDynamic = async (props: P) => {
        // Note: LoadingComponent is not used here — in the RSC environment,
        // async components suspend natively and parent <Suspense> boundaries
        // provide loading states. Error handling also defers to the nearest
        // error boundary in the component tree.
        const mod = await loader();
        const Component =
          "default" in mod
            ? (mod as { default: ComponentType<P> }).default
            : (mod as ComponentType<P>);
        return React.createElement(Component, props);
      };
      AsyncServerDynamic.displayName = "DynamicAsyncServer";
      // Cast is safe: async components are natively supported by the RSC renderer,
      // but TypeScript's ComponentType<P> doesn't account for async return types.
      return AsyncServerDynamic as unknown as ComponentType<P>;
    }

    // SSR path: Use React.lazy so that renderToReadableStream can suspend
    // until the dynamically-imported component is available.
    const LazyServer = createLazyComponent(loader);

    const ServerDynamic = (props: P) => {
      const fallback = LoadingComponent
        ? React.createElement(LoadingComponent, createDynamicLoadingProps())
        : null;
      const lazyElement = React.createElement(LazyServer, props);
      // Wrap with error boundary so loader rejections render the loading
      // component with the error instead of propagating uncaught.
      let content: React.ReactNode = lazyElement;
      if (LoadingComponent) {
        const ErrorBoundary = getDynamicErrorBoundary();
        if (ErrorBoundary) {
          content = React.createElement(
            ErrorBoundary,
            { fallback: LoadingComponent, retry: noopRetry, resetKey: 0 },
            lazyElement,
          );
        }
      }
      return React.createElement(React.Suspense, { fallback }, content);
    };

    ServerDynamic.displayName = "DynamicServer";
    return ServerDynamic;
  }

  const InitialLazyComponent = createLazyComponent(loader);

  const ClientDynamic = (props: P) => {
    const { LazyComponent, retry, retryKey } = useRetryableLazyComponent(
      loader,
      InitialLazyComponent,
    );
    const fallback = LoadingComponent
      ? React.createElement(LoadingComponent, createDynamicLoadingProps({ retry }))
      : null;
    const lazyElement = React.createElement(LazyComponent, props);
    let content: React.ReactNode = lazyElement;
    if (LoadingComponent) {
      const ErrorBoundary = getDynamicErrorBoundary();
      if (ErrorBoundary) {
        content = React.createElement(
          ErrorBoundary,
          { fallback: LoadingComponent, retry, resetKey: retryKey },
          lazyElement,
        );
      }
    }
    return React.createElement(React.Suspense, { fallback }, content);
  };

  ClientDynamic.displayName = "DynamicClient";
  return ClientDynamic;
}

export default dynamic;
