/**
 * next/dynamic shim
 *
 * SSR-safe dynamic imports. On the server, the module is eagerly loaded
 * and the promise is stored for the SSR handler to await before rendering.
 * On the client, uses React.lazy for code splitting.
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

// Detect server vs client
const isServer = typeof window === "undefined";

// Registry of all pending dynamic preloads — the SSR handler
// calls flushPreloads() to await them all before rendering.
const preloadQueue: Promise<void>[] = [];

/**
 * Wait for all pending dynamic() preloads to resolve, then clear the queue.
 * Called by the SSR handler before renderToString.
 */
export function flushPreloads(): Promise<void[]> {
  const pending = preloadQueue.splice(0);
  return Promise.all(pending);
}

function resolveComponent<P>(mod: { default: ComponentType<P> } | ComponentType<P>): ComponentType<P> {
  return ("default" in mod ? mod.default : mod) as ComponentType<P>;
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
      return React.createElement(
        Suspense,
        { fallback },
        React.createElement(LazyComponent, props),
      );
    };

    ClientSSRFalse.displayName = "DynamicClientSSRFalse";
    return ClientSSRFalse;
  }

  // SSR-enabled path
  if (isServer) {
    // Eagerly load the module and store the resolved component
    let Loaded: ComponentType<P> | null = null;
    const loadPromise = loader().then((mod) => {
      Loaded = resolveComponent(mod);
    });

    // Register in the preload queue so SSR handler can await it
    preloadQueue.push(loadPromise);

    const ServerDynamic = (props: P) => {
      if (Loaded) {
        return React.createElement(Loaded, props);
      }
      // Fallback: if somehow not loaded yet, show loading
      return LoadingComponent
        ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null })
        : null;
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
    return React.createElement(
      Suspense,
      { fallback },
      React.createElement(LazyComponent, props),
    );
  };

  ClientDynamic.displayName = "DynamicClient";
  return ClientDynamic;
}

export default dynamic;
