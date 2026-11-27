import { getOrCreateAls } from "./internal/als-registry.js";
import {
  _recordUseCacheRootParamRead,
  getRegisteredCacheContext,
} from "./internal/cache-context-accessor.js";
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
  | { kind: "route-handler"; routePattern: string }
  | { kind: "generate-static-params"; route: string };

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
// The "use cache" scope an unstable_cache() callback started in, set by cache.ts.
const _unstableCacheCallbackAls = getOrCreateAls<{ useCacheContext: unknown }>(
  "vinext.unstableCache.callbackAls",
);

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

/**
 * Like Next.js's `unstable-cache` work unit, an unstable_cache() callback has
 * no root params, and neither does a "use cache" scope entered from it: the
 * callback's entry is keyed by its source and arguments alone.
 */
function getUnstableCacheScope(): "callback" | "use-cache" | null {
  const callback = _unstableCacheCallbackAls.getStore();
  if (!callback) return null;
  return (callback.useCacheContext ?? null) === getRegisteredCacheContext()
    ? "callback"
    : "use-cache";
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
  const unstableCacheScope = getUnstableCacheScope();
  if (unstableCacheScope === "callback") {
    throw createRootParamsUsageError(
      `\`import('next/root-params').${name}()\` was used inside \`unstable_cache\`. This is not supported. Use \`"use cache"\` instead.`,
    );
  }
  if (unstableCacheScope === "use-cache") {
    throw createRootParamsUsageError(
      `\`import('next/root-params').${name}()\` was used inside \`"use cache"\` nested within \`unstable_cache\`. Root params are not available in this context.`,
    );
  }
  const rootParams = getState().rootParams;
  // Like Next.js's `generate-static-params` work unit, a generator sees only
  // the root params its parent generators provided. A "use cache" scope
  // inside it reads its root params without this check, as Next.js's `cache`
  // work unit does.
  if (
    usage?.kind === "generate-static-params" &&
    getRegisteredCacheContext() === null &&
    !(rootParams && Object.hasOwn(rootParams, name))
  ) {
    throw createRootParamsUsageError(
      `Route ${usage.route} used \`import('next/root-params').${name}()\` inside \`generateStaticParams\`, but the \`${name}\` parameter was not provided by a parent \`generateStaticParams\`. In \`generateStaticParams\`, root params are only available for segments nested below the segment that provides them.`,
    );
  }
  _recordUseCacheRootParamRead(name);
  return Promise.resolve(rootParams?.[name]);
}

/** @internal Current route root params for `"use cache"` key derivation. */
export function getCurrentRootParams(): RootParams | null {
  return getUnstableCacheScope() ? null : getState().rootParams;
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

/**
 * Run one generateStaticParams call with the root params its parent params
 * provide, as Next.js's build/static-paths/app.ts `callGenerateStaticParams`
 * does. Root params the parents did not provide are left out of the scope, so
 * reading one throws. `route` is the route in Next.js form (`/[lang]/[locale]`).
 */
export function runWithGenerateStaticParamsRootParams<T>(
  route: string,
  parentParams: Readonly<Record<string, unknown>>,
  rootParamNames: readonly string[],
  fn: () => T | Promise<T>,
): Promise<T> {
  const rootParams: RootParams = {};
  for (const name of rootParamNames) {
    if (Object.hasOwn(parentParams, name)) {
      rootParams[name] = parentParams[name] as RootParams[string];
    }
  }
  return runWithRootParamsScope(rootParams, () =>
    _usageAls.run({ kind: "generate-static-params", route, phase: "active" }, async () => fn()),
  );
}
