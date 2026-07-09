/**
 * Request-scoped Pages Router next/dynamic module usage.
 */
import { getOrCreateAls } from "./internal/als-registry.js";
import { _registerPagesDynamicStateAccessors } from "./pages-dynamic.js";
import {
  getRequestContext,
  isInsideUnifiedScope,
  runWithUnifiedStateMutation,
} from "./unified-request-context.js";

export type PagesDynamicState = {
  pagesDynamicModuleIds: Set<string>;
};

const _als = getOrCreateAls<PagesDynamicState>("vinext.pages-dynamic.als");

function getState(): PagesDynamicState | null {
  if (isInsideUnifiedScope()) return getRequestContext();
  return _als.getStore() ?? null;
}

export function runWithPagesDynamicState<T>(fn: () => T | Promise<T>): T | Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((context) => {
      context.pagesDynamicModuleIds = new Set();
    }, fn);
  }
  return _als.run({ pagesDynamicModuleIds: new Set() }, fn);
}

function recordPagesDynamicModuleIds(moduleIds: readonly string[] | undefined): void {
  const state = getState();
  if (!state || !moduleIds) return;
  for (const moduleId of moduleIds) state.pagesDynamicModuleIds.add(moduleId);
}

function getPagesDynamicModuleIds(): string[] | undefined {
  const moduleIds = getState()?.pagesDynamicModuleIds;
  return moduleIds && moduleIds.size > 0 ? Array.from(moduleIds) : undefined;
}

_registerPagesDynamicStateAccessors({
  recordPagesDynamicModuleIds,
  getPagesDynamicModuleIds,
});
