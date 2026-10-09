/**
 * next/dynamic shim
 *
 * SSR-safe dynamic imports. In App Router trees, uses React.lazy so that
 * renderToReadableStream suspends until the dynamically-imported component is
 * available, and (as in the Next.js App Router) adds a Suspense boundary only
 * for `ssr: false` or an explicit `loading` component. Other trees (Pages
 * Router) use a port of Next.js's react-loadable, which never suspends: the
 * server preloads every dynamic() before rendering (flushPreloads), and the
 * browser preloads the rendered ones before hydrating.
 *
 * Works in RSC, SSR, and client environments:
 * - RSC: Uses React.lazy (available in React 19.x react-server).
 *   Falls back to async component pattern if a future React version
 *   strips lazy from react-server.
 * - SSR and client: React.lazy in App Router trees, the loadable in Pages
 *   Router trees
 *
 * Supports:
 * - dynamic(import('./Component'))
 * - dynamic(() => import('./Component'))
 * - dynamic({ loader })
 * - dynamic(() => import('./Component'), { loading: () => <Spinner /> })
 * - dynamic(() => import('./Component'), { ssr: false })
 */
import React, { type ComponentType } from "react";
import { AppRouterTreeContext } from "./app-router-tree-context.js";
import { DynamicPreloadChunks } from "./dynamic-preload-chunks.js";
import { LoadableContext } from "./loadable-context.js";
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

const HAS_PAGES_ROUTER = process.env.__VINEXT_HAS_PAGES_ROUTER !== "false";

/**
 * Whether this dynamic() renders in an App Router tree. RSC renders the App
 * Router only, and react-server has no context support. On the server, the
 * App Router SSR entry marks its tree; in the browser, App Router documents
 * set `window.next.appDir` before anything renders, which also covers
 * separate client roots (e.g. a modal rendered with createRoot). Everything
 * else (Pages Router pages, `pages/_document`, ad-hoc react-dom/server
 * renders) uses the Pages Router loadable.
 */
function useIsAppRouterTree(): boolean {
  // Pure App Router builds have no Pages tree: a render outside the App
  // Router root (e.g. user code calling renderToString) keeps React.lazy.
  if (!HAS_PAGES_ROUTER) return true;
  if (!isServer) return window.next?.appDir === true;
  return AppRouterTreeContext ? React.use(AppRouterTreeContext) : true;
}

/**
 * The element tree around an SSR-enabled dynamic() component. The client
 * renders empty slots where the server renders the preload chunks, so both
 * sides render the same shape and useId values inside the dynamic component
 * match on hydration.
 *
 * Match Next.js App Router Loadable: the component only gets a Suspense
 * boundary when it has a `loading` component. Without one, the lazy component
 * suspends up to the nearest parent boundary, so the server shell waits for
 * the import instead of flushing an empty boundary and streaming the
 * component in after first paint. The Pages Router loadable never suspends,
 * so it renders without a boundary.
 *
 * React hoists the preload links out of place, but a hoisted <link> right
 * after a text node leaves a `<!-- -->` separator behind. Next.js avoids it by
 * hinting scripts with ReactDOM.preload(), which renders nothing. vinext
 * renders real modulepreload links (preloadModule() drops the nonce and
 * fetchPriority), so they go where text rarely precedes them: first inside the
 * boundary, or after the content when there is no boundary (a component whose
 * output ends in text still gets a separator after it). Stylesheets stay
 * before the boundary: a precedence stylesheet inside it makes React outline
 * the boundary even when its content is already resolved, and rendering them
 * ahead of the content keeps their nonce when the content links the same CSS.
 * A dynamic component with CSS right after text therefore still gets the
 * separator.
 */
function createDynamicBoundary(
  fallback: React.ReactNode,
  content: React.ReactNode,
  preloadModuleIds: readonly string[] | undefined,
  hasBoundary: boolean,
): React.ReactElement {
  const preloadChunks = (assets: "styles" | "scripts") =>
    isServer
      ? React.createElement(DynamicPreloadChunks, { moduleIds: preloadModuleIds, assets })
      : null;
  if (!hasBoundary) {
    return React.createElement(
      React.Fragment,
      null,
      preloadChunks("styles"),
      content,
      preloadChunks("scripts"),
    );
  }
  return React.createElement(
    React.Fragment,
    null,
    preloadChunks("styles"),
    React.createElement(React.Suspense, { fallback }, preloadChunks("scripts"), content),
  );
}

// ─── Pages Router loadable ──────────────────────────────────────────────
// Ported from Next.js's react-loadable fork:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/loadable.shared-runtime.tsx
// A Pages Router dynamic() never suspends. It renders the loading component
// until its module loads, so a client navigation commits right away. The
// server loads every dynamic() before rendering (flushPreloads) and reports
// the rendered modules into `__NEXT_DATA__.dynamicIds`; the browser loads
// those before hydrating (window.__NEXT_PRELOADREADY), so server-rendered
// dynamic components hydrate in place.
//
// Deliberate divergence: Next.js fails the first request when a server load
// rejects (preloadAll rejects). vinext imports every page module up front, so
// one failing dynamic() anywhere would fail the first request to every route;
// flushPreloads() logs the error instead, and the component renders its
// loading component with the error, as Next.js does on later requests.

type LoadResult<P> = {
  loading: boolean;
  loaded: ComponentType<P> | null;
  error: unknown;
  promise: Promise<ComponentType<P>>;
};

type LoadableState<P> = {
  loading: boolean;
  loaded: ComponentType<P> | null;
  error: unknown;
  pastDelay: boolean;
  timedOut: boolean;
};

type LoadableTimingOptions = {
  delay?: number | null;
  timeout?: number | null;
};

type Initializer = (ids: readonly (string | number)[] | undefined) => unknown;

type LoadableRegistry = {
  all: Set<Initializer>;
  ready: Initializer[];
  /** Set once the browser has hydrated: later dynamic() calls load on render. */
  initialized: boolean;
  /**
   * Server preloads (see trackPreload()) still in flight. A request that
   * starts while another request is preloading waits for them too, instead
   * of rendering their loading state (Next.js renders it, then mismatches on
   * hydration). So a preload that never settles holds every request, where
   * Next.js holds only the one that started it.
   */
  inFlight: Set<Promise<unknown>>;
};

function createLoadableRegistry(): LoadableRegistry {
  return { all: new Set(), ready: [], initialized: false, inFlight: new Set() };
}

// In the browser, on a global symbol like LoadableContext, so duplicate
// module instances share one registry and the single `__NEXT_PRELOADREADY`
// hook flushes it. The server loads this module once per module runner, and
// each keeps its own, so one dev server (or one before a restart) never
// flushes another's loaders.
const LOADABLE_REGISTRY_KEY = Symbol.for("vinext.loadableRegistry");
const registry: LoadableRegistry = isServer
  ? createLoadableRegistry()
  : ((globalThis as typeof globalThis & { [LOADABLE_REGISTRY_KEY]?: LoadableRegistry })[
      LOADABLE_REGISTRY_KEY
    ] ??= createLoadableRegistry());

/** For tests: server preloads registered and not yet started. */
export function _pendingServerPreloadCount(): number {
  return registry.all.size;
}

/**
 * Whether dynamic() calls register for Pages Router preloading. Pure App
 * Router builds, the RSC environment (no LoadableContext) and App Router
 * documents never preload, so they skip it and keep nothing alive.
 */
function tracksPagesPreloads(): boolean {
  if (!HAS_PAGES_ROUTER || !LoadableContext) return false;
  return isServer || window.next?.appDir !== true;
}

function reportServerLoadError(error: unknown): void {
  console.error("[vinext] next/dynamic failed to load a module on the server:", error);
}

function load<P>(loader: LoaderFn<P>): LoadResult<P> {
  const result: LoadResult<P> = {
    loading: true,
    loaded: null,
    error: null,
    promise: undefined as unknown as Promise<ComponentType<P>>,
  };
  result.promise = loader().then(
    (mod) => {
      result.loading = false;
      result.loaded = hasDefaultExport(mod) ? mod.default : mod;
      return result.loaded;
    },
    (error: unknown) => {
      result.loading = false;
      result.error = error;
      throw error;
    },
  );
  return result;
}

class LoadableSubscription<P> {
  private readonly loader: LoaderFn<P>;
  private readonly options: LoadableTimingOptions;
  private readonly callbacks = new Set<() => void>();
  private result!: LoadResult<P>;
  private state!: LoadableState<P>;
  private delayTimer: ReturnType<typeof setTimeout> | undefined;
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(loader: LoaderFn<P>, options: LoadableTimingOptions) {
    this.loader = loader;
    this.options = options;
    this.retry();
  }

  promise(): Promise<ComponentType<P>> {
    return this.result.promise;
  }

  retry = (): void => {
    this.clearTimeouts();
    this.result = load(this.loader);
    // update() fills in the load fields before anyone reads the state.
    this.state = { pastDelay: false, timedOut: false } as LoadableState<P>;

    const { delay = 200, timeout = null } = this.options;
    if (this.result.loading) {
      if (typeof delay === "number") {
        if (delay === 0) {
          this.state.pastDelay = true;
        } else {
          this.delayTimer = setTimeout(() => this.update({ pastDelay: true }), delay);
        }
      }
      if (typeof timeout === "number") {
        this.timeoutTimer = setTimeout(() => this.update({ timedOut: true }), timeout);
      }
    }

    const settle = () => {
      this.update({});
      this.clearTimeouts();
    };
    this.result.promise.then(settle, settle);
    this.update({});
  };

  getCurrentValue = (): LoadableState<P> => this.state;

  subscribe = (callback: () => void): (() => void) => {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  };

  private update(partial: Partial<LoadableState<P>>): void {
    this.state = {
      ...this.state,
      error: this.result.error,
      loaded: this.result.loaded,
      loading: this.result.loading,
      ...partial,
    };
    for (const callback of this.callbacks) callback();
  }

  private clearTimeouts(): void {
    clearTimeout(this.delayTimer);
    clearTimeout(this.timeoutTimer);
  }
}

/** Next.js's default `loading` for dynamic(): the error in development, else nothing. */
function DefaultLoading({ error, isLoading, pastDelay }: DynamicOptionsLoadingProps) {
  if (!pastDelay) return null;
  if (process.env.NODE_ENV !== "production") {
    if (isLoading) return null;
    if (error) {
      return React.createElement("p", null, error.message, React.createElement("br"), error.stack);
    }
  }
  return null;
}

/**
 * Starts a server preload that flushPreloads() waits for until it settles.
 * `report` logs a failure (the divergence noted above); App Router renders
 * leave theirs to React.
 */
function trackPreload(init: Initializer, report: boolean): void {
  try {
    const promise = Promise.resolve(init(undefined));
    const settle = () => {
      registry.inFlight.delete(promise);
    };
    registry.inFlight.add(promise);
    promise.then(settle, (error: unknown) => {
      settle();
      if (report) reportServerLoadError(error);
    });
  } catch (error) {
    if (report) reportServerLoadError(error);
  }
}

type PagesLoadableComponent<P> = ComponentType<P> & {
  takeForAppRouter(): Promise<ComponentType<P>> | null;
};

function createPagesLoadable<P>(
  loader: LoaderFn<P>,
  options: LoadableTimingOptions & {
    loading: ComponentType<DynamicOptionsLoadingProps>;
    /**
     * Call-site keys reported in `__NEXT_DATA__.dynamicIds` and matched by
     * the browser. Undefined for `ssr: false`, which Next.js never preloads.
     */
    loadableKeys: readonly string[] | undefined;
    /** Module ids for the preload chunks; undefined renders no preload links. */
    preloadModuleIds: readonly string[] | undefined;
    ssr: boolean;
  },
): PagesLoadableComponent<P> {
  let subscription: LoadableSubscription<P> | null = null;
  function init(): Promise<ComponentType<P>> {
    subscription ??= new LoadableSubscription(loader, options);
    return subscription.promise();
  }

  const { loading: Loading, loadableKeys, preloadModuleIds, ssr } = options;
  const registered = ssr && tracksPagesPreloads();
  if (registered) {
    if (isServer) {
      // Known limitation: in an app with a pages/ directory, App Router
      // modules share this registry, so an App Router dynamic() the server
      // never renders (or one created per render, which Next.js documents
      // against) stays here until a Pages request flushes it. Next.js bundles
      // the App Router separately and never loads it.
      registry.all.add(init);
    } else if (!registry.initialized && !window.__NEXT_HYDRATED && loadableKeys) {
      // `__NEXT_HYDRATED` covers a shim first loaded after hydration (no
      // dynamic() on the initial page), when preloadReady never runs.
      registry.ready.push((ids) => {
        for (const key of loadableKeys) {
          if (ids?.includes(key)) return init();
        }
        return undefined;
      });
    }
  }

  // Like Next.js's LoadableComponent, a ref gets `{ retry }` rather than
  // reaching the loaded component.
  const PagesDynamic = (allProps: P) => {
    const { ref, ...props } = allProps as P & { ref?: React.Ref<{ retry: () => void }> };
    void init();
    const captureModule = LoadableContext ? React.use(LoadableContext) : null;
    if (captureModule && loadableKeys) {
      for (const key of loadableKeys) captureModule(key);
    }
    const sub = subscription!;
    const state = React.useSyncExternalStore(
      sub.subscribe,
      sub.getCurrentValue,
      sub.getCurrentValue,
    );
    React.useImperativeHandle(ref, () => ({ retry: sub.retry }), [sub]);

    let content: React.ReactNode = null;
    if (state.loading || state.error) {
      content = React.createElement(Loading, {
        isLoading: state.loading,
        pastDelay: state.pastDelay,
        timedOut: state.timedOut,
        error: (state.error as Error | null) ?? null,
        retry: sub.retry,
      });
    } else if (state.loaded) {
      content = createElementWithProps(state.loaded, props as P);
    }
    // ssr: false renders the content alone, like the server's loading state.
    if (!ssr) return content;
    return createDynamicBoundary(null, content, preloadModuleIds, false);
  };
  PagesDynamic.displayName = "DynamicPages";
  return Object.assign(PagesDynamic, {
    // App Router trees render with React.lazy and never flush Pages preloads.
    // When this dynamic() is registered for them, the App Router render takes
    // the load (one loader call for both) and the entry leaves the server
    // preload list, so calls made per render don't pile up in App-only
    // traffic, and a Pages page sharing the component finds it loaded.
    takeForAppRouter() {
      if (!isServer || !registered) return null;
      if (registry.all.delete(init)) trackPreload(init, false);
      return init();
    },
  });
}

function flushInitializers(
  initializers: Initializer[],
  ids?: readonly (string | number)[],
): Promise<void> {
  const promises: unknown[] = [];
  while (initializers.length) {
    promises.push(initializers.pop()!(ids));
  }
  // Loading a module can call dynamic() again, so flush until none are left.
  return Promise.all(promises).then(() => {
    if (initializers.length) return flushInitializers(initializers, ids);
  });
}

/**
 * Loads every SSR-enabled dynamic() created so far, like Next.js's
 * `Loadable.preloadAll()`. The Pages Router awaits this before each render so
 * dynamic components render on the server instead of their loading state.
 * Unlike preloadAll(), a failed load is logged rather than rejected (see the
 * divergence note above); the component renders its loading component with
 * the error.
 */
export async function flushPreloads(): Promise<void> {
  // Loading a module can call dynamic() again, so drain until nothing is
  // left to start or to wait for.
  while (registry.all.size > 0 || registry.inFlight.size > 0) {
    const initializers = [...registry.all];
    registry.all.clear();
    for (const init of initializers) trackPreload(init, true);
    await Promise.allSettled(registry.inFlight);
  }
}

/**
 * Loads the dynamic() components whose modules the server rendered, like
 * Next.js's `Loadable.preloadReady()`. Always resolves: errors render in the
 * loading component.
 */
function preloadReady(ids: readonly (string | number)[] = []): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      registry.initialized = true;
      resolve();
    };
    flushInitializers(registry.ready, ids).then(done, done);
  });
}

if (HAS_PAGES_ROUTER && !isServer) {
  window.__NEXT_PRELOADREADY = preloadReady;
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
  // The transform also emits environment-independent call-site keys for the
  // Pages Router loadable (see dynamic-preload-metadata.ts).
  const loadableKeys =
    (loadableGenerated as unknown as { loadableKeys?: string[] } | undefined)?.loadableKeys ??
    preloadModuleIds;
  const { delay, timeout } = normalizedOptions as LoadableTimingOptions;

  // ssr: false — render nothing on the server, lazy-load on client
  if (!ssr) {
    if (isServer) {
      // On the server (SSR or RSC), just render the loading state or nothing
      const SSRFalse = (_props: P) => {
        if (!useIsAppRouterTree()) {
          // Next.js Pages Router noSSR(): the loading component (or the
          // default) before its delay, matching the client loadable's first
          // render.
          return React.createElement(LoadingComponent ?? DefaultLoading, {
            error: null,
            isLoading: true,
            pastDelay: false,
            timedOut: false,
          });
        }
        return LoadingComponent
          ? // pastDelay must be true here to match (a) the client's first/pre-mount
            // render (AppClientSSRFalse uses createDynamicLoadingProps, which defaults
            // pastDelay to true) and (b) Next.js App Router, which always renders the
            // loading fallback with pastDelay=true on both server and client. Hardcoding
            // false produced a hydration mismatch for loading components that branch on
            // pastDelay, e.g. `if (!pastDelay) return null` (issue 1967).
            React.createElement(LoadingComponent, createDynamicLoadingProps())
          : null;
      };
      SSRFalse.displayName = "DynamicSSRFalse";
      return SSRFalse;
    }

    const InitialLazyComponent = createLazyComponent(loader);
    // Next.js Pages Router: a loadable that is never preloaded. The
    // HAS_PAGES_ROUTER checks compile the Pages paths out of pure App builds.
    const PagesSSRFalse = HAS_PAGES_ROUTER
      ? createPagesLoadable(loader, {
          loading: LoadingComponent ?? DefaultLoading,
          delay,
          timeout,
          loadableKeys: undefined,
          preloadModuleIds: undefined,
          ssr: false,
        })
      : null;

    const AppClientSSRFalse = (props: P) => {
      const [mounted, setMounted] = React.useState(false);
      const { LazyComponent, retry, retryKey } = useRetryableLazyComponent(
        loader,
        InitialLazyComponent,
      );
      // Keep the first hydration render equal to the server's loading fallback.
      // oxlint-disable-next-line react/set-state-in-effect -- client-only loading starts after mount
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
    AppClientSSRFalse.displayName = "DynamicAppClientSSRFalse";

    const ClientSSRFalse = (props: P) =>
      createElementWithProps(
        useIsAppRouterTree() || !PagesSSRFalse ? AppClientSSRFalse : PagesSSRFalse,
        props,
      );
    ClientSSRFalse.displayName = "DynamicClientSSRFalse";
    return ClientSSRFalse;
  }

  // SSR-enabled path
  const PagesDynamic = HAS_PAGES_ROUTER
    ? createPagesLoadable(loader, {
        loading: LoadingComponent ?? DefaultLoading,
        delay,
        timeout,
        loadableKeys,
        preloadModuleIds,
        ssr: true,
      })
    : null;

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
    const LazyServer = createLazyComponent(() => {
      const taken = PagesDynamic?.takeForAppRouter();
      return taken ? taken.then((Component) => ({ default: Component })) : loader();
    });

    const AppServerDynamic = (props: P) => {
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
      return createDynamicBoundary(fallback, content, preloadModuleIds, LoadingComponent != null);
    };
    AppServerDynamic.displayName = "DynamicAppServer";

    const ServerDynamic = (props: P) =>
      createElementWithProps(
        useIsAppRouterTree() || !PagesDynamic ? AppServerDynamic : PagesDynamic,
        props,
      );
    ServerDynamic.displayName = "DynamicServer";
    return ServerDynamic;
  }

  const InitialLazyComponent = createLazyComponent(loader);

  const AppClientDynamic = (props: P) => {
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
    return createDynamicBoundary(fallback, content, preloadModuleIds, LoadingComponent != null);
  };
  AppClientDynamic.displayName = "DynamicAppClient";

  const ClientDynamic = (props: P) =>
    createElementWithProps(
      useIsAppRouterTree() || !PagesDynamic ? AppClientDynamic : PagesDynamic,
      props,
    );
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
