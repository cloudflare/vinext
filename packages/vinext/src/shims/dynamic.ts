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
import { DynamicPreloadChunks } from "./dynamic-preload-chunks.js";
import type {
  DynamicOptions,
  DynamicOptionsLoadingProps,
  LoadableComponent,
  LoadableFn,
  LoadableGeneratedOptions,
  LoadableOptions,
  Loader,
  LoaderComponent,
  LoaderMap,
} from "@vinext/types/next/upstream/dynamic";

export type {
  DynamicOptions,
  DynamicOptionsLoadingProps,
  LoadableComponent,
  LoadableFn,
  LoadableGeneratedOptions,
  LoadableOptions,
  Loader,
  LoaderComponent,
  LoaderMap,
};

type ComponentModule<P = {}> = { default: ComponentType<P> };
type LoaderFn<P> = () => LoaderComponent<P>;

type DynamicInput<P> = DynamicOptions<P> | Loader<P>;
type VinextLoadableModules = string[] | ((this: void) => LoaderMap);

const noopRetry = () => {};

function createDynamicLoadingProps(
  overrides: Partial<DynamicOptionsLoadingProps> = {},
): DynamicOptionsLoadingProps {
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

function normalizeLoader<P>(loader: Loader<P>): LoaderFn<P> {
  if (typeof loader === "function") {
    return loader;
  }
  return () => loader;
}

function normalizeDynamicOptions<P>(
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

function createLazyComponent<P>(loader: LoaderFn<P>) {
  return React.lazy(async () => {
    const mod = await loader();
    if (hasDefaultExport(mod)) return mod;
    return { default: mod };
  });
}

function useRetryableLazyComponent<P>(
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

function createElementWithProps<P>(Component: ComponentType<P>, props: P): React.ReactElement {
  return React.createElement(Component as ComponentType<object>, props as object);
}

type DynamicErrorBoundaryProps = {
  fallback: ComponentType<DynamicOptionsLoadingProps>;
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

function dynamic<P = {}>(
  dynamicInput: DynamicInput<P>,
  options?: DynamicOptions<P>,
): ComponentType<P> {
  const normalizedOptions = normalizeDynamicOptions(dynamicInput, options);
  const {
    loader: dynamicLoader,
    loadableGenerated,
    loading: LoadingComponent,
    ssr = true,
  } = normalizedOptions;
  if (dynamicLoader && typeof dynamicLoader === "object" && !(dynamicLoader instanceof Promise)) {
    throw new Error("next/dynamic loader maps are not supported by vinext");
  }
  const loader = dynamicLoader ? normalizeLoader(dynamicLoader) : () => Promise.resolve(() => null);
  // vinext's transform emits the already-resolved module id array, while
  // Next's public type also permits the legacy modules() loader map.
  const generatedModules = (
    loadableGenerated as unknown as { modules?: VinextLoadableModules } | undefined
  )?.modules;
  const optionModules = (normalizedOptions as unknown as { modules?: VinextLoadableModules })
    .modules;
  const configuredModules = generatedModules ?? optionModules;
  const preloadModuleIds =
    typeof configuredModules === "function" ? Object.keys(configuredModules()) : configuredModules;

  // ssr: false — render nothing on the server, lazy-load on client
  if (!ssr) {
    if (isServer) {
      // On the server (SSR or RSC), just render the loading state or nothing
      const SSRFalse = (_props: P) =>
        LoadingComponent
          ? // pastDelay must be true here to match (a) the client's first/pre-mount
            // render (ClientSSRFalse uses createDynamicLoadingProps, which defaults
            // pastDelay to true) and (b) Next.js App Router, which always renders the
            // loading fallback with pastDelay=true on both server and client. Hardcoding
            // false produced a hydration mismatch for loading components that branch on
            // pastDelay, e.g. `if (!pastDelay) return null` (issue 1967).
            React.createElement(LoadingComponent, createDynamicLoadingProps())
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
      const lazyElement = createElementWithProps(LazyComponent, props);
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
        return createElementWithProps(Component, props);
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
      const lazyElement = createElementWithProps(LazyServer, props);
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
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(DynamicPreloadChunks, { moduleIds: preloadModuleIds }),
        React.createElement(React.Suspense, { fallback }, content),
      );
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
    const lazyElement = createElementWithProps(LazyComponent, props);
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

export function noSSR<P = {}>(
  LoadableInitializer: LoadableFn<P>,
  loadableOptions: DynamicOptions<P>,
): React.ComponentType<P> {
  // Match Next's legacy helper: prevent react-loadable metadata from
  // preloading, and never invoke the initializer during server rendering.
  delete loadableOptions.webpack;
  delete loadableOptions.modules;

  if (!isServer) {
    return LoadableInitializer(loadableOptions);
  }

  const Loading = loadableOptions.loading!;
  const NoSSR = () =>
    React.createElement(Loading, {
      error: null,
      isLoading: true,
      pastDelay: false,
      timedOut: false,
    });
  NoSSR.displayName = "NoSSR";
  return NoSSR;
}

export default dynamic;
