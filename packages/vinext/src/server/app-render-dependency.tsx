import { type ReactNode } from "react";

export type AppRenderDependency = {
  promise: Promise<void>;
  release: () => void;
};

const appElementRenderDependencies = new WeakMap<
  Readonly<Record<string, unknown>>,
  ReadonlyMap<string, AppRenderDependency>
>();

// Write-only until the enable slice: this map is populated here so the
// per-element render dependencies are registered ahead of the consumer
// (`releaseAppElementRenderDependency`) that lands with enable-transport. It is
// keyed by the elements object and GCs with it, so it is harmless while unread.
export function registerAppElementRenderDependencies(
  elements: Readonly<Record<string, unknown>>,
  dependenciesByElementId: ReadonlyMap<string, AppRenderDependency>,
): void {
  if (dependenciesByElementId.size === 0) return;
  appElementRenderDependencies.set(elements, dependenciesByElementId);
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
    // are allowed to observe. If Phase 2 adds AbortSignal-based render
    // timeouts, this dependency will also need an abort/reject path so stuck
    // async layouts do not suspend downstream entries forever.
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
