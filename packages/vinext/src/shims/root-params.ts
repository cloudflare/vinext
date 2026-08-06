import { getOrCreateAls } from "./internal/als-registry.js";
import {
  getRequestContext,
  isInsideUnifiedScope,
  runWithUnifiedStateMutation,
} from "./unified-request-context.js";

export type RootParams = Record<string, string | string[] | undefined>;

export type RootParamsState = {
  rootParams: RootParams | null;
};

export type RootParamsUsage =
  | { kind: "route" }
  | { kind: "server-action" }
  | { kind: "route-handler"; routePattern: string };

type RootParamsUsageState = RootParamsUsage & {
  phase: "active" | "render";
};

export type RootParamsUsageController = {
  transitionToRender(): void;
};

function createRootParamsUsageError(message: string): Error {
  return new Error(message);
}

const _FALLBACK_KEY = Symbol.for("vinext.rootParams.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = getOrCreateAls<RootParamsState>("vinext.rootParams.als");
const _usageAls = getOrCreateAls<RootParamsUsageState>("vinext.rootParams.usage.als");

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  rootParams: null,
} satisfies RootParamsState) as RootParamsState;

function getState(): RootParamsState {
  if (isInsideUnifiedScope()) {
    return getRequestContext();
  }
  return _als.getStore() ?? _fallbackState;
}

export function pickRootParams(
  params: RootParams,
  rootParamNames: readonly string[] | null | undefined,
): RootParams {
  const picked: RootParams = {};
  for (const name of rootParamNames ?? []) {
    picked[name] = params[name];
  }
  return picked;
}

export function setRootParams(params: RootParams | null): void {
  getState().rootParams = params;
}

export function getRootParam(name: string): Promise<string | string[] | undefined> {
  const usage = _usageAls.getStore();
  if (usage?.kind === "server-action" && usage.phase === "active") {
    throw createRootParamsUsageError(
      `\`import('next/root-params').${name}()\` was used inside a Server Action. This is not supported. Functions from 'next/root-params' can only be called in the context of a route.`,
    );
  }
  if (usage?.kind === "route-handler" && usage.phase === "active") {
    throw createRootParamsUsageError(
      `Route ${usage.routePattern} used \`import('next/root-params').${name}()\` inside a Route Handler. Support for this API in Route Handlers is planned for a future version of Next.js.`,
    );
  }
  return Promise.resolve(getState().rootParams?.[name]);
}

export function runWithRootParamsUsage<T>(
  usage: RootParamsUsage,
  fn: () => Promise<T>,
  controller?: RootParamsUsageController,
): Promise<T>;
export function runWithRootParamsUsage<T>(
  usage: RootParamsUsage,
  fn: () => T | Promise<T>,
  controller?: RootParamsUsageController,
): T | Promise<T>;
export function runWithRootParamsUsage<T>(
  usage: RootParamsUsage,
  fn: () => T | Promise<T>,
  controller?: RootParamsUsageController,
): T | Promise<T> {
  const state: RootParamsUsageState = { ...usage, phase: "active" };
  if (controller) {
    controller.transitionToRender = () => {
      if (usage.kind === "server-action") state.phase = "render";
    };
  }
  return _usageAls.run(state, fn);
}

export function createRootParamsUsageController(): RootParamsUsageController {
  return { transitionToRender() {} };
}

export function runWithRootParamsScope<T>(params: RootParams, fn: () => Promise<T>): Promise<T>;
export function runWithRootParamsScope<T>(
  params: RootParams,
  fn: () => T | Promise<T>,
): T | Promise<T>;
export function runWithRootParamsScope<T>(
  params: RootParams,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((ctx) => {
      ctx.rootParams = params;
    }, fn);
  } else {
    return _als.run({ rootParams: params }, fn);
  }
}
