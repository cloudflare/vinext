import { type ReactNode } from "react";

export type AppRenderDependency = {
  promise: Promise<void>;
  release: () => void;
};

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

export function renderAfterAppDependencies(
  children: ReactNode,
  dependencies: readonly AppRenderDependency[],
): ReactNode {
  if (dependencies.length === 0) {
    return children;
  }

  async function AwaitAppRenderDependencies() {
    await Promise.all(dependencies.map((dependency) => dependency.promise));
    return children;
  }

  return <AwaitAppRenderDependencies />;
}

export function renderWithAppDependencyBarrier(
  children: ReactNode,
  dependency: AppRenderDependency,
): ReactNode {
  function ReleaseAppRenderDependency() {
    // This render-time release is intentional. The dependency barrier is only
    // used inside the RSC render graph, where producing this leaf means the
    // owning entry has reached the serialization point that downstream entries
    // are allowed to observe.
    dependency.release();
    return null;
  }

  return (
    <>
      {children}
      <ReleaseAppRenderDependency />
    </>
  );
}
