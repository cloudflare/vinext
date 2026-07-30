import { createElement, use, type ComponentType, type ReactNode } from "react";
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
  render?: (props: Readonly<Record<string, unknown>>, ref: null) => ReactNode | Promise<ReactNode>;
  type?: AppDependencyComponent;
};

const REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");
const REACT_FORWARD_REF = Symbol.for("react.forward_ref");
const REACT_LAZY = Symbol.for("react.lazy");
const REACT_MEMO = Symbol.for("react.memo");

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
): ReactNode {
  // Flight may continue serializing sibling entries while an exotic wrapper
  // is suspended. Unwrap server-owned wrappers here so dependency release is
  // tied to their actual result; client references and classes remain owned by
  // React and only need their element to be produced synchronously.
  function invokeComponent(candidate: AppDependencyComponent): ReactNode | Promise<ReactNode> {
    if (candidate.$$typeof === REACT_MEMO && candidate.type) {
      return invokeComponent(candidate.type);
    }

    if (candidate.$$typeof === REACT_LAZY && candidate._init && candidate._payload !== undefined) {
      return invokeComponent(candidate._init(candidate._payload));
    }

    if (candidate.$$typeof === REACT_FORWARD_REF && candidate.render) {
      return candidate.render(props, null);
    }

    if (
      typeof candidate !== "function" ||
      candidate.$$typeof === REACT_CLIENT_REFERENCE ||
      candidate.prototype?.isReactComponent != null
    ) {
      return createElement(candidate, props);
    }

    const ServerComponent = candidate as unknown as (
      props: Readonly<Record<string, unknown>>,
    ) => ReactNode | Promise<ReactNode>;
    return ServerComponent(props);
  }

  function AppComponentDependencyBarrier() {
    try {
      const result = invokeComponent(component as AppDependencyComponent);
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
