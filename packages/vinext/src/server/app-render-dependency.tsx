import {
  cloneElement,
  createElement,
  isValidElement,
  use,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { isPromiseLike } from "../utils/promise.js";
import {
  createPprFallbackShellSuspensePromise,
  getPprFallbackShellState,
  markPprFallbackShellOmittedBoundary,
  markPprFallbackShellRuntimeEligibleComponent,
  runWithPprFallbackShellRuntimeDiscovery,
} from "vinext/shims/ppr-fallback-shell";
import { resolveCachedNavigationRuntimeRenderAction } from "./app-cached-navigation-runtime.js";

export type AppRenderDependency = {
  promise: Promise<void>;
  release: () => void;
};

export type AppPageRenderDependency = AppRenderDependency & {
  resultDependencies: readonly AppRenderDependency[];
  setResultDependencies: (dependencies: readonly AppRenderDependency[]) => void;
};

type AppDependencyComponent = ComponentType<Record<string, unknown>> & {
  $$typeof?: symbol;
  _init?: (payload: unknown) => AppDependencyComponent;
  _payload?: unknown;
  prototype?: { isReactComponent?: unknown };
  render?: (
    props: Readonly<Record<string, unknown>>,
    ref: undefined,
  ) => ReactNode | Promise<ReactNode>;
  type?: AppDependencyComponent;
};

const REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");
const REACT_FORWARD_REF = Symbol.for("react.forward_ref");
const REACT_LAZY = Symbol.for("react.lazy");
const REACT_MEMO = Symbol.for("react.memo");
const REACT_SUSPENSE = Symbol.for("react.suspense");

export function isReactOwnedAppComponent(component: unknown): boolean {
  const candidate = component as AppDependencyComponent | null;

  if (
    candidate?.$$typeof === REACT_MEMO ||
    candidate?.$$typeof === REACT_LAZY ||
    candidate?.$$typeof === REACT_FORWARD_REF
  ) {
    return false;
  }

  return (
    typeof candidate !== "function" ||
    candidate.$$typeof === REACT_CLIENT_REFERENCE ||
    candidate.prototype?.isReactComponent != null
  );
}

function invokeAppComponent(
  component: ComponentType<Record<string, unknown>>,
  props: Readonly<Record<string, unknown>>,
): ReactNode | Promise<ReactNode> {
  const candidate = component as AppDependencyComponent;

  if (candidate.$$typeof === REACT_MEMO && candidate.type) {
    return invokeAppComponent(candidate.type, props);
  }

  if (candidate.$$typeof === REACT_LAZY && candidate._init) {
    return invokeAppComponent(candidate._init(candidate._payload), props);
  }

  if (candidate.$$typeof === REACT_FORWARD_REF && candidate.render) {
    return candidate.render(props, undefined);
  }

  if (isReactOwnedAppComponent(candidate)) {
    return createElement(candidate, props);
  }

  const ServerComponent = candidate as unknown as (
    props: Readonly<Record<string, unknown>>,
  ) => ReactNode | Promise<ReactNode>;
  return ServerComponent(props);
}

type CachedNavigationRuntimeElement = ReactElement<
  Record<string, unknown>,
  string | ComponentType<Record<string, unknown>>
>;

function isPlainRscObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function wrapCachedNavigationRuntimeValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (isValidElement(value)) {
    return wrapCachedNavigationRuntimeSubtree(value, seen);
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (isPromiseLike(value)) {
    const wrapped = Promise.resolve(value).then((resolved) =>
      wrapCachedNavigationRuntimeValue(resolved, seen),
    );
    seen.set(value, wrapped);
    return wrapped;
  }

  if (Array.isArray(value)) {
    const wrapped: unknown[] = [];
    seen.set(value, wrapped);
    for (const item of value) {
      wrapped.push(wrapCachedNavigationRuntimeValue(item, seen));
    }
    return wrapped;
  }

  if (value instanceof Map) {
    const wrapped = new Map<unknown, unknown>();
    seen.set(value, wrapped);
    for (const [key, item] of value) {
      wrapped.set(
        wrapCachedNavigationRuntimeValue(key, seen),
        wrapCachedNavigationRuntimeValue(item, seen),
      );
    }
    return wrapped;
  }

  if (value instanceof Set) {
    const wrapped = new Set<unknown>();
    seen.set(value, wrapped);
    for (const item of value) {
      wrapped.add(wrapCachedNavigationRuntimeValue(item, seen));
    }
    return wrapped;
  }

  if (!isPlainRscObject(value)) {
    // Typed arrays, Dates, FormData, blobs and user-defined iterables are
    // serialized as their own RSC value kinds. Re-shaping any of them into an
    // array would change the value received by the client component.
    return value;
  }

  const wrapped = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, wrapped);
  for (const key of Object.keys(value)) {
    wrapped[key] = wrapCachedNavigationRuntimeValue(value[key], seen);
  }
  return wrapped;
}

function getCachedNavigationRuntimeRenderedPropNames(
  element: CachedNavigationRuntimeElement,
): readonly string[] {
  const type = element.type as AppDependencyComponent | string | symbol;
  if (
    typeof type !== "string" &&
    typeof type !== "symbol" &&
    type?.$$typeof === REACT_CLIENT_REFERENCE
  ) {
    // RSC resolves server-element values embedded in any client-reference prop
    // before serializing that prop to the browser, so every prop is a render
    // position for this element type.
    return Object.keys(element.props);
  }
  if (type === REACT_SUSPENSE) {
    return ["children", "fallback"];
  }

  // Host elements, Fragment/other React built-ins, contexts/providers, and
  // classes only hand `children` to React automatically. Other element-valued
  // props can be application data (notably a context provider's `value`) and
  // must retain their original element identity until user code renders them.
  return ["children"];
}

/**
 * Carry a runtime-prefetch opt-in through user server components returned by
 * the opted loader-tree module. React invokes those descendants after the
 * parent page/layout has already resolved its JSX, so the parent's ALS scope
 * alone cannot observe their asynchronous private-cache work.
 *
 * React-owned elements (host nodes, Suspense/Fragment, client references, and
 * classes) keep their normal invocation path. Their React-node props are
 * traversed so server components passed through children, fallbacks, or named
 * slots receive their own discovery scope when React eventually renders them.
 */
function wrapCachedNavigationRuntimeSubtree(
  node: ReactNode,
  seen: WeakMap<object, unknown> = new WeakMap(),
): ReactNode {
  if (!isValidElement(node)) {
    return wrapCachedNavigationRuntimeValue(node, seen) as ReactNode;
  }

  const element = node as CachedNavigationRuntimeElement;
  if (!isReactOwnedAppComponent(element.type)) {
    return createElement(CachedNavigationRuntimeSubtreeInvoker, {
      element,
      key: element.key,
    });
  }

  let changed = false;
  let wrappedChildren: unknown;
  let childrenChanged = false;
  const wrappedProps: Record<string, unknown> = {};
  for (const key of getCachedNavigationRuntimeRenderedPropNames(element)) {
    if (!Object.hasOwn(element.props, key)) continue;
    const value = element.props[key];
    const next = wrapCachedNavigationRuntimeValue(value, seen);
    if (next === value) continue;
    changed = true;
    if (key === "children") {
      childrenChanged = true;
      wrappedChildren = next;
    } else {
      wrappedProps[key] = next;
    }
  }
  if (!changed) return element;
  if (!childrenChanged) return cloneElement(element, wrappedProps);
  return Array.isArray(wrappedChildren)
    ? cloneElement(element, wrappedProps, ...wrappedChildren)
    : cloneElement(element, wrappedProps, wrappedChildren as ReactNode);
}

function CachedNavigationRuntimeSubtreeInvoker({
  element,
}: {
  element: CachedNavigationRuntimeElement;
}): ReactNode | Promise<ReactNode> {
  const result = runWithPprFallbackShellRuntimeDiscovery(() =>
    invokeAppComponent(element.type as ComponentType<Record<string, unknown>>, element.props),
  );
  return isPromiseLike(result)
    ? Promise.resolve(result).then((resolved) =>
        wrapCachedNavigationRuntimeSubtree(resolved as ReactNode),
      )
    : wrapCachedNavigationRuntimeSubtree(result as ReactNode);
}

export function invokeAppComponentWithCachedNavigationRuntime(
  component: ComponentType<Record<string, unknown>>,
  props: Readonly<Record<string, unknown>>,
  runtimeRequestApis: boolean,
): ReactNode | Promise<ReactNode> {
  const state = getPprFallbackShellState();
  if (
    !runtimeRequestApis ||
    (state?.cachedNavigationStage !== "runtime" && state?.cachedNavigationStage !== "navigation")
  ) {
    return invokeAppComponent(component, props);
  }

  const result = runWithPprFallbackShellRuntimeDiscovery(() =>
    invokeAppComponent(component, props),
  );
  return isPromiseLike(result)
    ? Promise.resolve(result).then((resolved) =>
        wrapCachedNavigationRuntimeSubtree(resolved as ReactNode),
      )
    : wrapCachedNavigationRuntimeSubtree(result as ReactNode);
}

const appElementRenderDependencies = new WeakMap<
  Readonly<Record<string, unknown>>,
  ReadonlyMap<string, AppRenderDependency>
>();

export function registerAppElementRenderDependencies(
  elements: Readonly<Record<string, unknown>>,
  dependenciesByElementId: ReadonlyMap<string, AppRenderDependency>,
): void {
  if (dependenciesByElementId.size === 0) return;
  appElementRenderDependencies.set(elements, dependenciesByElementId);
}

export function releaseAppElementRenderDependency(
  elements: Readonly<Record<string, unknown>>,
  elementId: string,
): void {
  appElementRenderDependencies.get(elements)?.get(elementId)?.release();
}

export function createAppRenderDependency(): AppRenderDependency {
  let released = false;
  let resolve!: () => void;

  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return {
    promise,
    release() {
      if (released) {
        return;
      }
      released = true;
      resolve();
    },
  };
}

export function createAppPageRenderDependency(): AppPageRenderDependency {
  const initialization = createAppRenderDependency();
  let resultDependencies: readonly AppRenderDependency[] = [];

  return {
    ...initialization,
    get resultDependencies() {
      return resultDependencies;
    },
    setResultDependencies(dependencies) {
      resultDependencies = dependencies;
    },
  };
}

export function isAppRenderSuspension(error: unknown): boolean {
  if (isPromiseLike(error)) {
    return true;
  }

  return (
    error instanceof Error &&
    error.message.startsWith("Suspense Exception: This is not a real error!")
  );
}

export function renderAfterAppDependencies(
  children: ReactNode,
  dependencies: readonly AppRenderDependency[],
): ReactNode {
  if (dependencies.length === 0) {
    return children;
  }

  // AppRenderDependency promises are resolve-only by construction. If an
  // abort/reject path is added later, use() will deliberately surface that
  // rejection through the render error-boundary path.
  const pendingDependencies = Promise.all(dependencies.map((dependency) => dependency.promise));

  function AwaitAppRenderDependencies() {
    use(pendingDependencies);
    return children;
  }

  return <AwaitAppRenderDependencies />;
}

export function renderAppComponentWithDependencyBarrier(
  component: ComponentType<Record<string, unknown>>,
  props: Readonly<Record<string, unknown>>,
  dependency: AppRenderDependency,
  runtimeRequestApis = false,
  omitWhenRuntimeDisabled = false,
): ReactNode {
  // Flight may continue serializing sibling entries while an exotic wrapper
  // is suspended. Unwrap server-owned wrappers here so dependency release is
  // tied to their actual result; client references and classes remain owned by
  // React and only need their element to be produced synchronously.
  function AppComponentDependencyBarrier() {
    try {
      if (
        !prepareAppComponentCachedNavigationRuntime(runtimeRequestApis, omitWhenRuntimeDisabled)
      ) {
        dependency.release();
        return props.children as ReactNode;
      }
      const result = invokeAppComponentWithCachedNavigationRuntime(
        component,
        props,
        runtimeRequestApis,
      );
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (resolvedResult) => {
            dependency.release();
            return resolvedResult;
          },
          (error: unknown) => {
            dependency.release();
            throw error;
          },
        );
      }

      dependency.release();
      return result;
    } catch (error) {
      // A thrown thenable is React-owned suspension. Releasing here would let
      // dependent flat Flight entries run before this component's retry has
      // produced its result. Ordinary errors cannot retry, so release them to
      // avoid leaving sibling entries suspended forever while the error is
      // serialized by the owning boundary.
      if (!isAppRenderSuspension(error)) {
        dependency.release();
      }
      throw error;
    }
  }

  return createElement(AppComponentDependencyBarrier);
}

export function renderAppComponentWithCachedNavigationRuntime(
  component: ComponentType<Record<string, unknown>>,
  props: Readonly<Record<string, unknown>>,
  runtimeRequestApis: boolean,
  omitWhenDisabled = false,
): ReactNode {
  function CachedNavigationRuntimeComponentInvoker(invocationProps: Record<string, unknown>) {
    if (!prepareAppComponentCachedNavigationRuntime(runtimeRequestApis, omitWhenDisabled)) {
      return invocationProps.children as ReactNode;
    }
    return invokeAppComponentWithCachedNavigationRuntime(
      component,
      invocationProps,
      runtimeRequestApis,
    );
  }
  CachedNavigationRuntimeComponentInvoker.displayName =
    (component as { displayName?: string; name?: string }).displayName ??
    (component as { name?: string }).name ??
    "CachedNavigationRuntimeComponent";

  return createElement(CachedNavigationRuntimeComponentInvoker, props);
}

export function prepareAppComponentCachedNavigationRuntime(
  eligible: boolean,
  omitWhenDisabled = false,
): boolean {
  if (eligible) {
    markPprFallbackShellRuntimeEligibleComponent();
  }
  const action = resolveCachedNavigationRuntimeRenderAction({
    eligible,
    omitWhenDisabled,
    stage: getPprFallbackShellState()?.cachedNavigationStage ?? null,
  });
  if (action === "render") return true;
  if (action === "omit") {
    markPprFallbackShellOmittedBoundary();
    return false;
  }
  const pending = createPprFallbackShellSuspensePromise<never>(
    'a loader-tree branch without `unstable_instant: { prefetch: "runtime" }`',
  );
  if (pending) throw pending;
  return true;
}
