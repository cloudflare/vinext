import { AsyncLocalStorage } from "node:async_hooks";

type EdgeRuntimeGlobal = typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};

export function installEdgeRuntimeGlobals(target: typeof globalThis = globalThis): void {
  const edgeGlobal = target as EdgeRuntimeGlobal;
  edgeGlobal.AsyncLocalStorage ??= AsyncLocalStorage;
}

installEdgeRuntimeGlobals();
