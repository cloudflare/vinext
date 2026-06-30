import {
  createPartialRscShellState,
  getPartialRscShellState,
  preparePartialRscShellFinalRender,
  runWithPartialRscShellState,
  waitForPartialRscShellSettled,
  type PartialRscShellState,
} from "vinext/shims/partial-rsc-shell";
import {
  runWithPartialRscShellRequestApiScope,
  type PartialRscShellRequestApiScope,
} from "vinext/shims/partial-rsc-shell-request-api";

export type StaticNavigationShellRenderState = PartialRscShellState;

type StaticNavigationShellScope = PartialRscShellRequestApiScope;

export function createStaticNavigationShellRenderState(options: {
  fallbackParamNames: readonly string[];
  includeRuntimeRequestApis: boolean;
  routePattern: string;
}): StaticNavigationShellRenderState {
  return createPartialRscShellState({
    fallbackParamNames: options.fallbackParamNames,
    includePrivateCacheTasks: options.includeRuntimeRequestApis,
    routePattern: options.routePattern,
  });
}

export function prepareStaticNavigationShellFinalRender(
  state: StaticNavigationShellRenderState,
): void {
  preparePartialRscShellFinalRender(state);
}

export function runWithStaticNavigationShellRenderState<T>(
  state: StaticNavigationShellRenderState,
  fn: () => T,
): T {
  return runWithPartialRscShellState(state, fn);
}

export function getStaticNavigationShellRenderState(): StaticNavigationShellRenderState | null {
  return getPartialRscShellState();
}

export function waitForStaticNavigationShellSettled(
  state: StaticNavigationShellRenderState,
): Promise<void> {
  return waitForPartialRscShellSettled(state);
}

export function runWithStaticNavigationShellScope<T>(
  scope: StaticNavigationShellScope,
  fn: () => T,
): T {
  return runWithPartialRscShellRequestApiScope(scope, fn);
}
