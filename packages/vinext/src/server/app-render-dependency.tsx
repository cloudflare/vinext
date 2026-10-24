import {
  createElement,
  Fragment,
  isValidElement,
  use,
  type ComponentType,
  type ReactNode,
} from "react";
import { isPromiseLike } from "../utils/promise.js";

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

/** Whether `component` is a "use client" export seen from the RSC environment. */
export function isAppClientReference(component: unknown): boolean {
  return (component as AppDependencyComponent | null)?.$$typeof === REACT_CLIENT_REFERENCE;
}

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

/**
 * `mapError` replaces an error thrown by a CSS-wrapped export's inner
 * component, which renders after this call returns. The caller maps the
 * errors this call throws or rejects with.
 */
export function invokeAppComponent(
  component: ComponentType<Record<string, unknown>>,
  props: Readonly<Record<string, unknown>>,
  mapError?: (error: unknown) => unknown,
): ReactNode | Promise<ReactNode> {
  return invokeAppComponentObserved(component, props, mapError, undefined);
}

/**
 * Reports how a component's own render ended: `failure` holds what it threw
 * or rejected with, after `mapError`. A suspension isn't an end, as React
 * renders the component again.
 */
export type AppComponentSettledCallback = (failure?: { error: unknown }) => void;

/**
 * Like `invokeAppComponent()`. `onSettled` hears of a value returned
 * synchronously; the caller reports a promise result or a thrown error.
 */
function invokeAppComponentObserved(
  component: ComponentType<Record<string, unknown>>,
  props: Readonly<Record<string, unknown>>,
  mapError: ((error: unknown) => unknown) | undefined,
  onSettled: AppComponentSettledCallback | undefined,
): ReactNode | Promise<ReactNode> {
  const candidate = component as AppDependencyComponent;

  if (candidate.$$typeof === REACT_MEMO && candidate.type) {
    return invokeAppComponentObserved(candidate.type, props, mapError, onSettled);
  }

  if (candidate.$$typeof === REACT_LAZY && candidate._init) {
    return invokeAppComponentObserved(
      candidate._init(candidate._payload),
      props,
      mapError,
      onSettled,
    );
  }

  if (candidate.$$typeof === REACT_FORWARD_REF && candidate.render) {
    const result = candidate.render(props, undefined);
    if (!isPromiseLike(result)) onSettled?.();
    return result;
  }

  if (isReactOwnedAppComponent(candidate)) {
    onSettled?.();
    return createElement(candidate, props);
  }

  const ServerComponent = candidate as unknown as (
    props: Readonly<Record<string, unknown>>,
  ) => ReactNode | Promise<ReactNode>;
  const result = ServerComponent(props);
  return isPromiseLike(result)
    ? result
    : invokeCssWrappedComponent(result, props, mapError, onSettled);
}

/**
 * `invokeAppComponent()`, with every error the component throws or rejects
 * with replaced by `mapError(error)`, including its CSS-wrapped inner one's.
 * `onSettled` hears once how the component, or that inner one, ended.
 */
export function invokeAppComponentMappingErrors(
  component: ComponentType<Record<string, unknown>>,
  props: Readonly<Record<string, unknown>>,
  mapError: (error: unknown) => unknown,
  onSettled?: AppComponentSettledCallback,
): ReactNode | Promise<ReactNode> {
  const fail = (error: unknown): unknown => {
    if (isAppRenderSuspension(error)) return error;
    const mapped = mapError(error);
    onSettled?.({ error: mapped });
    return mapped;
  };
  try {
    const result = invokeAppComponentObserved(component, props, mapError, onSettled);
    return isPromiseLike(result) ? trackAppComponentResult(result, fail, onSettled) : result;
  } catch (error) {
    throw fail(error);
  }
}

type AppComponentThenable = Promise<ReactNode> & {
  reason?: unknown;
  status?: unknown;
  value?: unknown;
};

/**
 * Records how `result` settles on the promise itself, as React's thenables
 * do, with `fail(error)` as a rejection's reason. Flight then reads that
 * outcome rather than tracking the promise, so the result reaches it in the
 * same tick as an unmapped one. A promise chained with `.then()` resolves a
 * tick later, which costs a large page about a tenth more render work.
 */
function trackAppComponentResult(
  result: Promise<ReactNode>,
  fail: (error: unknown) => unknown,
  onSettled: AppComponentSettledCallback | undefined,
): Promise<ReactNode> {
  const thenable = result as AppComponentThenable;
  if (thenable.status !== undefined) {
    // Something already records its outcome, so map it on a new promise.
    return Promise.resolve(result).then(
      (value) => {
        onSettled?.();
        return value;
      },
      (error: unknown) => {
        throw fail(error);
      },
    );
  }
  thenable.status = "pending";
  thenable.then(
    (value) => {
      thenable.status = "fulfilled";
      thenable.value = value;
      onSettled?.();
    },
    (error: unknown) => {
      thenable.status = "rejected";
      thenable.reason = fail(error);
    },
  );
  return thenable;
}

/**
 * Whether `elementProps` are what `createElement(type, props)` produces: the
 * same values, plus any `type.defaultProps` for keys that are `undefined`.
 * Defaulted values aren't read again, since a default can be a getter.
 */
function isElementOfProps(
  elementProps: Readonly<Record<string, unknown>>,
  props: Readonly<Record<string, unknown>>,
  defaultProps: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const keys = new Set(Object.keys(props));
  const defaulted = new Set<string>();
  for (const key in defaultProps) {
    if (props[key] === undefined) {
      keys.add(key);
      defaulted.add(key);
    }
  }
  return (
    Object.keys(elementProps).length === keys.size &&
    [...keys].every(
      (key) =>
        Object.hasOwn(elementProps, key) &&
        (defaulted.has(key) || Object.is(elementProps[key], props[key])),
    )
  );
}

/**
 * `@vitejs/plugin-rsc` wraps a server component export whose module imports
 * CSS (`__vite_rsc_wrap_css__`). The wrapper returns
 * `<><Css /><Component {...props} /></>`, so a component vinext invokes
 * directly renders as an element with its props after all. React's dev build
 * serializes an element's props as debug info and calls `then` on `params`
 * and `searchParams`, which counts as reading them. Invoke the inner
 * component from an element without props instead, as for an export without
 * CSS.
 */
function invokeCssWrappedComponent(
  result: ReactNode,
  props: Readonly<Record<string, unknown>>,
  mapError: ((error: unknown) => unknown) | undefined,
  onSettled: AppComponentSettledCallback | undefined,
): ReactNode {
  const wrapped = readCssWrappedComponent(result, props);
  if (!wrapped) {
    onSettled?.();
    return result;
  }
  const { component, componentProps, css } = wrapped;
  function CssWrappedComponent() {
    return mapError
      ? invokeAppComponentMappingErrors(component, componentProps, mapError, onSettled)
      : invokeAppComponent(component, componentProps);
  }
  CssWrappedComponent.displayName = component.displayName ?? component.name;
  return createElement(Fragment, null, css, createElement(CssWrappedComponent));
}

/** The parts of `result`, if it's a CSS-wrapped export's element for `props`. */
function readCssWrappedComponent(
  result: ReactNode,
  props: Readonly<Record<string, unknown>>,
): {
  component: ComponentType<Record<string, unknown>>;
  componentProps: Readonly<Record<string, unknown>>;
  css: ReactNode;
} | null {
  if (
    !isValidElement<{ children?: unknown }>(result) ||
    result.type !== Fragment ||
    result.key !== null
  ) {
    return null;
  }
  const children = result.props.children;
  if (!Array.isArray(children) || children.length !== 2) return null;
  const [css, inner] = children as [ReactNode, unknown];
  if (
    !isValidElement<Record<string, unknown>>(inner) ||
    typeof inner.type !== "function" ||
    inner.key !== null
  ) {
    return null;
  }
  const component = inner.type as ComponentType<Record<string, unknown>> & {
    defaultProps?: Readonly<Record<string, unknown>>;
  };
  if (!isElementOfProps(inner.props, props, component.defaultProps)) return null;
  // The element's props, so the component gets its defaultProps as before.
  return { component, componentProps: inner.props, css };
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
  mapError?: (error: unknown) => unknown,
  onSettled?: AppComponentSettledCallback,
): ReactNode {
  // Flight may continue serializing sibling entries while an exotic wrapper
  // is suspended. Unwrap server-owned wrappers here so dependency release is
  // tied to their actual result; client references and classes remain owned by
  // React and only need their element to be produced synchronously.
  function AppComponentDependencyBarrier() {
    try {
      const result = mapError
        ? invokeAppComponentMappingErrors(component, props, mapError, onSettled)
        : invokeAppComponent(component, props);
      if (isPromiseLike(result)) {
        // Released before React reads the result, which stays as it is: a
        // mapped one records its outcome on itself, and a chained promise
        // would reach React a tick later.
        const release = () => dependency.release();
        result.then(release, release);
        return result;
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
