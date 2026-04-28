import { AsyncLocalStorage } from "node:async_hooks";
import { getRequestContext, isInsideUnifiedScope } from "./unified-request-context.js";

export type RootParams = Record<string, string | string[] | undefined>;

export type RootParamsState = {
  rootParams: RootParams | null;
};

const _ALS_KEY = Symbol.for("vinext.rootParams.als");
const _FALLBACK_KEY = Symbol.for("vinext.rootParams.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = (_g[_ALS_KEY] ??=
  new AsyncLocalStorage<RootParamsState>()) as AsyncLocalStorage<RootParamsState>;

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  rootParams: null,
} satisfies RootParamsState) as RootParamsState;

function getState(): RootParamsState {
  if (isInsideUnifiedScope()) {
    return getRequestContext();
  }
  return _als.getStore() ?? _fallbackState;
}

export function runWithRootParamsContext<T>(fn: () => Promise<T>): Promise<T>;
export function runWithRootParamsContext<T>(fn: () => T | Promise<T>): T | Promise<T>;
export function runWithRootParamsContext<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return _als.run({ rootParams: null }, fn);
}

export function setRootParams(params: RootParams | null): void {
  getState().rootParams = params;
}

export function getRootParam(name: string): Promise<string | string[] | undefined> {
  return Promise.resolve(getState().rootParams?.[name]);
}
