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
  const candidate = component as ComponentType<Record<string, unknown>> & {
    $$typeof?: symbol;
    prototype?: { isReactComponent?: unknown };
  };
  const isReactOwnedComponent =
    typeof candidate !== "function" ||
    candidate.$$typeof === Symbol.for("react.client.reference") ||
    candidate.prototype?.isReactComponent != null;

  if (isReactOwnedComponent) {
    function ReactOwnedComponentBarrier() {
      dependency.release();
      return createElement(component, props);
    }

    return createElement(ReactOwnedComponentBarrier);
  }

  const ServerComponent = component as unknown as (
    props: Readonly<Record<string, unknown>>,
  ) => ReactNode | Promise<ReactNode>;

  function AppComponentDependencyBarrier() {
    try {
      const result = ServerComponent(props);
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
