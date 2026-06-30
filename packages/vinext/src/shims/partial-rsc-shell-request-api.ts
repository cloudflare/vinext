import { getOrCreateAls } from "./internal/als-registry.js";
import { createPartialRscShellSuspensePromise } from "./partial-rsc-shell.js";

export type PartialRscShellRequestApi = "connection" | "cookies" | "headers" | "searchParams";

export type PartialRscShellRequestApiScope = {
  includeRuntimeRequestApis: boolean;
};

const partialRscShellRequestApiAls = getOrCreateAls<PartialRscShellRequestApiScope>(
  "vinext.partialRscShell.requestApiAls",
);

export function runWithPartialRscShellRequestApiScope<T>(
  scope: PartialRscShellRequestApiScope,
  fn: () => T,
): T {
  return partialRscShellRequestApiAls.run(scope, fn);
}

function getPartialRscShellRequestApiScope(): PartialRscShellRequestApiScope | null {
  return partialRscShellRequestApiAls.getStore() ?? null;
}

export function isPartialRscShellRequestApiScopeActive(): boolean {
  return getPartialRscShellRequestApiScope() !== null;
}

function shouldSuspendPartialRscShellRequestApi(
  scope: PartialRscShellRequestApiScope,
  api: PartialRscShellRequestApi,
): boolean {
  if (api === "connection") return true;
  return !scope.includeRuntimeRequestApis;
}

export function createPartialRscShellRequestApiSuspensePromise<T>(
  api: PartialRscShellRequestApi,
): Promise<T> | null {
  const scope = getPartialRscShellRequestApiScope();
  if (scope === null || !shouldSuspendPartialRscShellRequestApi(scope, api)) {
    return null;
  }
  return createPartialRscShellSuspensePromise<T>(api);
}
