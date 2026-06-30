import {
  createPprFallbackShellSuspensePromiseForState,
  getPprFallbackShellState,
} from "./ppr-fallback-shell.js";

function hasParamProperty<T extends Record<string, unknown>>(obj: T, prop: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

// Properties that cannot be shadowed by param names because they need to
// remain the true underlying value for Promises / React to work correctly.
//
// Next.js comments out `value` and `error` in reflect-utils.ts because they
// use `Promise.resolve(underlyingParams)` directly in production, so React
// mutations on the promise object are never shadowed. vinext uses a Proxy
// that intercepts sync reads through a separate `plain` object, which means
// a param named `value` or `error` would shadow React's `.status`/`.value`
// attachments that React adds to resolved promises for `use()` caching.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/utils/reflect-utils.ts
const WELL_KNOWN_PROPERTIES = [
  // Object prototype
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "toLocaleString",

  // Promise prototype
  "then",
  "catch",
  "finally",

  // React Promise extension (status is explicitly reserved by Next.js;
  // value/error are reserved here because our Proxy-based approach creates
  // a shadowing risk that native Promise does not have)
  "status",
  "value",
  "error",

  // React introspection
  "displayName",
  "_debugInfo",

  // Common tested properties
  "toJSON",
  "$$typeof",
  "__esModule",

  // Tested by flight when checking for iterables
  "@@iterator",
] as const;

// The type-level set of well-known properties is derived directly from the
// runtime array above, so they can never drift out of sync. These properties
// are omitted from the synchronous intersection because the Proxy returns
// Promise/React internals for them, not the param value. After awaiting, the
// resolved object contains the actual param values for all keys.
type WellKnownProperty = (typeof WELL_KNOWN_PROPERTIES)[number];

const wellKnownProperties = new Set<PropertyKey>(WELL_KNOWN_PROPERTIES);

function isWellKnownProperty(prop: PropertyKey): boolean {
  return wellKnownProperties.has(prop);
}

export type ThenableParams<T extends Record<string, unknown>> = Promise<T> &
  Omit<T, WellKnownProperty>;

export type ThenableParamsObserver = Readonly<{
  observeParamAccess: (keys: readonly string[]) => void;
  observeReactPromiseStatus?: boolean;
}>;

function observeParamKeys(
  observer: ThenableParamsObserver | undefined,
  keys: readonly string[],
): void {
  if (observer) {
    observer.observeParamAccess(keys);
  }
}

function observeAllParamKeys<T extends Record<string, unknown>>(
  observer: ThenableParamsObserver | undefined,
  plain: T,
): void {
  observeParamKeys(observer, Object.keys(plain));
}

function observeReadableParamKeys<T extends Record<string, unknown>>(
  observer: ThenableParamsObserver | undefined,
  plain: T,
): void {
  const keys = Object.keys(plain).filter((key) => !isWellKnownProperty(key));
  observeParamKeys(observer, keys);
}

function isPromiseContinuation(prop: PropertyKey): boolean {
  return prop === "then" || prop === "catch" || prop === "finally";
}

/**
 * Build a proxy around `plain` that preserves fallback-key suspension.
 * This is the value `await params` resolves to during fallback-shell
 * prerendering. Known params are readable synchronously; fallback params
 * suspend (throw a hanging promise) only when actually accessed.
 *
 * The handler is typed as `ProxyHandler<T>` and no cast is needed because
 * the target is already `plain: T`.
 */
function createResolvedParamsProxy<T extends Record<string, unknown>>(
  plain: T,
  fallbackParamNames: ReadonlySet<string> | null,
  observer: ThenableParamsObserver | undefined,
  getFallbackShellPromise: () => Promise<T> | null,
): T {
  if ((!fallbackParamNames || fallbackParamNames.size === 0) && observer === undefined) {
    return plain;
  }

  function isFallbackParam(prop: PropertyKey): boolean {
    return typeof prop === "string" && fallbackParamNames !== null && fallbackParamNames.has(prop);
  }

  const handler: ProxyHandler<T> = {
    get(_target, prop, _receiver) {
      if (typeof prop === "string" && !isWellKnownProperty(prop)) {
        observeParamKeys(observer, [prop]);
      }

      if (!isWellKnownProperty(prop) && hasParamProperty(plain, prop)) {
        if (isFallbackParam(prop)) {
          const p = getFallbackShellPromise();
          if (p) throw p;
        }
        return Reflect.get(plain, prop);
      }

      return Reflect.get(plain, prop);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && !isWellKnownProperty(prop)) {
        observeParamKeys(observer, [prop]);
      }

      if (!isWellKnownProperty(prop) && hasParamProperty(plain, prop)) {
        if (isFallbackParam(prop)) {
          return {
            configurable: true,
            enumerable: true,
            get() {
              const p = getFallbackShellPromise();
              if (p) throw p;
            },
          };
        }

        return {
          configurable: true,
          enumerable: true,
          value: Reflect.get(plain, prop),
          writable: true,
        };
      }

      return Reflect.getOwnPropertyDescriptor(plain, prop);
    },
    has(_target, prop) {
      if (typeof prop === "string" && !isWellKnownProperty(prop)) {
        observeParamKeys(observer, [prop]);
      }

      return (
        Reflect.has(plain, prop) || (!isWellKnownProperty(prop) && hasParamProperty(plain, prop))
      );
    },
    ownKeys() {
      observeReadableParamKeys(observer, plain);
      return Reflect.ownKeys(plain).filter((prop) => !isWellKnownProperty(prop));
    },
  };

  return new Proxy(plain, handler);
}

/**
 * Wrap a `Promise<T>` with a proxy that also exposes param properties for
 * synchronous access. TypeScript cannot prove this hybrid shape statically,
 * so the single `as ThenableParams<T>` cast is isolated here.
 */
function createThenableParamsProxy<T extends Record<string, unknown>>(
  promise: Promise<T>,
  handler: ProxyHandler<Promise<T>>,
): ThenableParams<T> {
  return new Proxy(promise, handler) as ThenableParams<T>;
}

export function makeThenableParams<T extends Record<string, unknown>>(
  obj: T,
  observer?: ThenableParamsObserver,
): ThenableParams<T> {
  const plain = { ...obj };
  const fallbackShellState = getPprFallbackShellState();
  const fallbackParamNames =
    fallbackShellState &&
    Object.keys(plain).some((key) => fallbackShellState.fallbackParamNames.has(key))
      ? fallbackShellState.fallbackParamNames
      : null;
  let fallbackShellPromise: Promise<T> | null = null;
  let fallbackShellPromiseController: AbortController | null = null;

  function getFallbackShellPromise(): Promise<T> | null {
    // `fallbackParamNames` is non-null only when this params object was built
    // inside a fallback-shell scope that owns one of these keys, so the
    // originating `fallbackShellState` is captured here rather than re-read
    // lazily from the ALS store. Capturing keeps fallback-key access suspending
    // against the shell that produced this object even if the object escapes
    // the ALS scope before the key is read — without it, an out-of-scope read
    // would return `null` and silently leak the raw `[slug]` placeholder (and
    // diverge between the `get` and `getOwnPropertyDescriptor` traps).
    // Promise creation stays lazy so the dynamic-boundary side effects only
    // fire on first actual fallback-key access.
    if (!fallbackParamNames || !fallbackShellState) return null;
    // `preparePprFallbackShellFinalRender` swaps in a fresh `AbortController`
    // on the warmup->final transition. Re-derive the hanging promise whenever
    // the live controller has changed so suspension always tracks the
    // controller the lifecycle will actually abort, instead of a stale signal
    // from a prior phase. This also re-applies the dynamic-boundary side
    // effects against the current phase.
    if (
      fallbackShellPromise &&
      fallbackShellPromiseController === fallbackShellState.abortController
    ) {
      return fallbackShellPromise;
    }
    fallbackShellPromiseController = fallbackShellState.abortController;
    fallbackShellPromise = createPprFallbackShellSuspensePromiseForState<T>(
      fallbackShellState,
      "`params`",
    );
    return fallbackShellPromise;
  }

  const resolvedParams = createResolvedParamsProxy(
    plain,
    fallbackParamNames,
    observer,
    getFallbackShellPromise,
  );

  const promise = Promise.resolve(resolvedParams);

  function isFallbackParam(prop: PropertyKey): boolean {
    return typeof prop === "string" && (fallbackParamNames?.has(prop) ?? false);
  }

  const handler: ProxyHandler<Promise<T>> = {
    get(target, prop, receiver) {
      if (isPromiseContinuation(prop)) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          // Only observe all keys when NOT in fallback-shell mode.
          // In fallback-shell mode, let the resolved params proxy report
          // actual property access lazily.
          if (!fallbackParamNames) {
            observeAllParamKeys(observer, plain);
          }
          return Reflect.apply(value, target, args);
        };
      }

      if (prop === "status" && observer?.observeReactPromiseStatus === true) {
        observeAllParamKeys(observer, plain);
      }

      if (typeof prop === "string" && !isWellKnownProperty(prop)) {
        observeParamKeys(observer, [prop]);
      }

      if (!isWellKnownProperty(prop) && hasParamProperty(plain, prop)) {
        if (isFallbackParam(prop)) {
          const p = getFallbackShellPromise();
          if (p) throw p;
        }
        return Reflect.get(plain, prop);
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && !isWellKnownProperty(prop)) {
        observeParamKeys(observer, [prop]);
      }

      if (!isWellKnownProperty(prop) && hasParamProperty(plain, prop)) {
        if (isFallbackParam(prop)) {
          return {
            configurable: true,
            enumerable: true,
            get() {
              const p = getFallbackShellPromise();
              if (p) throw p;
            },
          };
        }

        return {
          configurable: true,
          enumerable: true,
          value: Reflect.get(plain, prop),
          writable: true,
        };
      }

      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    has(target, prop) {
      if (typeof prop === "string" && !isWellKnownProperty(prop)) {
        observeParamKeys(observer, [prop]);
      }

      return (
        Reflect.has(target, prop) || (!isWellKnownProperty(prop) && hasParamProperty(plain, prop))
      );
    },
    ownKeys() {
      observeReadableParamKeys(observer, plain);
      return Reflect.ownKeys(plain).filter((prop) => !isWellKnownProperty(prop));
    },
  };

  return createThenableParamsProxy(promise, handler);
}
