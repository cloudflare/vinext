"use client";
/**
 * next/dynamic shim
 *
 * SSR-safe dynamic imports. On the server, uses React.lazy + Suspense so that
 * renderToReadableStream suspends until the dynamically-imported component is
 * available. On the client, also uses React.lazy for code splitting.
 *
 * Supports:
 * - dynamic(() => import('./Component'))
 * - dynamic(() => import('./Component'), { loading: () => <Spinner /> })
 * - dynamic(() => import('./Component'), { ssr: false })
 */
import React, { lazy, Suspense, type ComponentType, useState, useEffect } from "react";

interface DynamicOptions {
  loading?: ComponentType<{ error?: Error | null; isLoading?: boolean; pastDelay?: boolean }>;
  ssr?: boolean;
}

type Loader<P> = () => Promise<{ default: ComponentType<P> } | ComponentType<P>>;

/**
 * Lightweight error boundary that renders the loading component with the error
 * when a dynamic() loader rejects. Without this, loader failures would propagate
 * uncaught through React's rendering — this preserves the Next.js behavior where
 * the `loading` component can display errors.
 *
 * Lazily created because React.Component is not available in the RSC environment
 * (server components use a slimmed-down React that doesn't include class components).
 */
let DynamicErrorBoundary: any;
function getDynamicErrorBoundary() {
  if (DynamicErrorBoundary) return DynamicErrorBoundary;
  if (!React.Component) return null;
  DynamicErrorBoundary = class extends (
    React.Component<
      {
        fallback: ComponentType<{ error?: Error | null; isLoading?: boolean; pastDelay?: boolean }>;
        children: React.ReactNode;
      },
      { error: Error | null }
    >
  ) {
    constructor(props: any) {
      super(props);
      this.state = { error: null };
    }
    static getDerivedStateFromError(error: unknown) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
    render() {
      if (this.state.error) {
        return React.createElement(this.props.fallback, {
          isLoading: false,
          pastDelay: true,
          error: this.state.error,
        });
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
  loader: Loader<P>,
  options?: DynamicOptions,
): ComponentType<P> {
  const { loading: LoadingComponent, ssr = true } = options ?? {};

  // ssr: false — render nothing on the server, lazy-load on client
  if (!ssr) {
    if (isServer) {
      // On the server, just render the loading state or nothing
      const SSRFalse = (_props: P) => {
        return LoadingComponent
          ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null })
          : null;
      };
      SSRFalse.displayName = "DynamicSSRFalse";
      return SSRFalse;
    }

    // Client: use lazy with Suspense
    const LazyComponent = lazy(async () => {
      const mod = await loader();
      if ("default" in mod) return mod as { default: ComponentType<P> };
      return { default: mod as ComponentType<P> };
    });

    const ClientSSRFalse = (props: P) => {
      const [mounted, setMounted] = useState(false);
      useEffect(() => setMounted(true), []);

      if (!mounted) {
        return LoadingComponent
          ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null })
          : null;
      }

      const fallback = LoadingComponent
        ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null })
        : null;
      return React.createElement(Suspense, { fallback }, React.createElement(LazyComponent, props));
    };

    ClientSSRFalse.displayName = "DynamicClientSSRFalse";
    return ClientSSRFalse;
  }

  // SSR-enabled path
  if (isServer) {
    // Use React.lazy so that renderToReadableStream can suspend until the
    // dynamically-imported component is available. The previous eager-load
    // pattern relied on flushPreloads() being called before rendering, which
    // works for the Pages Router but not the App Router where client modules
    // are loaded lazily during RSC stream deserialization (issue #75).
    const LazyServer = lazy(async () => {
      const mod = await loader();
      if ("default" in mod) return mod as { default: ComponentType<P> };
      return { default: mod as ComponentType<P> };
    });

    const ServerDynamic = (props: P) => {
      const fallback = LoadingComponent
        ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null })
        : null;
      const lazyElement = React.createElement(LazyServer, props);
      // Wrap with error boundary so loader rejections render the loading
      // component with the error instead of propagating uncaught.
      const ErrorBoundary = LoadingComponent ? getDynamicErrorBoundary() : null;
      const content = ErrorBoundary
        ? React.createElement(ErrorBoundary, { fallback: LoadingComponent }, lazyElement)
        : lazyElement;
      return React.createElement(Suspense, { fallback }, content);
    };

    ServerDynamic.displayName = "DynamicServer";
    return ServerDynamic;
  }

  // Client path: standard React.lazy with Suspense
  const LazyComponent = lazy(async () => {
    const mod = await loader();
    if ("default" in mod) return mod as { default: ComponentType<P> };
    return { default: mod as ComponentType<P> };
  });

  const ClientDynamic = (props: P) => {
    const fallback = LoadingComponent
      ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null })
      : null;
    return React.createElement(Suspense, { fallback }, React.createElement(LazyComponent, props));
  };

  ClientDynamic.displayName = "DynamicClient";
  return ClientDynamic;
}

export default dynamic;
