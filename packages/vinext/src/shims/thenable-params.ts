import {
  createPprFallbackShellSuspensePromiseForState,
  getPprFallbackShellState,
  recordPprFallbackShellVaryParams,
  type PprFallbackShellState,
} from "./ppr-fallback-shell.js";
import {
  isOwnPropertyCheck,
  isWellKnownProperty,
  type WellKnownProperty,
} from "./internal/thenable-well-known-properties.js";

function hasParamProperty<T extends Record<string, unknown>>(obj: T, prop: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

export type ThenableParams<T extends Record<string, unknown>> = Promise<T> &
  Omit<T, WellKnownProperty>;

export type ThenableParamsObserver = Readonly<{
  observeParamAccess: (keys: readonly string[]) => void;
  /**
   * Runs when `then` is read, and when `catch` or `finally` is called (they
   * read `then` on a native promise). Throwing here fails the read itself
   * before React counts any pending work, as Next.js does.
   */
  observeThenRead?: () => void;
}>;

/** Whether the thenable holds search params, whose reads vary on `?`. */
export type ThenableParamsOptions = Readonly<{ isSearchParams?: boolean }>;

const paramsState = new WeakMap<
  object,
  {
    plain: Record<string, unknown>;
    observer: ThenableParamsObserver | undefined;
    fallbackShellState: PprFallbackShellState | null;
    options: ThenableParamsOptions | undefined;
    varyShellState: PprFallbackShellState | null;
  }
>();

function getParamsState(value: unknown) {
  return value !== null && typeof value === "object" ? paramsState.get(value) : undefined;
}

/** Serialize backing values without reading a framework fallback-key proxy. */
export function getFallbackParamsSnapshot(
  value: unknown,
): Promise<Record<string, unknown>> | undefined {
  const state = getParamsState(value);
  return state?.fallbackShellState ? Promise.resolve(state.plain) : undefined;
}

/** Reattach only framework metadata; argument values always come from the decoder. */
export function restoreThenableParams<T extends Record<string, unknown>>(
  decoded: T,
  original: unknown,
): ThenableParams<T> {
  const state = getParamsState(original);
  return createThenableParams(
    decoded,
    state?.observer,
    state?.fallbackShellState ?? null,
    state?.options,
    state?.varyShellState ?? null,
  );
}

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
  options?: ThenableParamsOptions,
): ThenableParams<T> {
  const shellState = getPprFallbackShellState();
  return createThenableParams(obj, observer, shellState, options, shellState);
}

/** The optional catch-all params of a route pattern, such as `slug` in `/:slug*`. */
function getOptionalCatchAllParamNames(routePattern: string): string[] {
  return routePattern
    .split("/")
    .filter((part) => part.startsWith(":") && part.endsWith("*"))
    .map((part) => part.slice(1, -1));
}

/**
 * The values `then` resolves to while a shell records its vary params: reading
 * a key records it, and enumerating the keys records them all, the route's
 * optional catch-alls included, since which keys are present varies too. Like
 * Next.js's `createVaryingParams`.
 */
function createVaryingParams<T extends Record<string, unknown>>(
  plain: T,
  recordRead: (key: string) => void,
  recordEnumeration: () => void,
): T {
  return new Proxy(plain, {
    get(target, prop, receiver) {
      if (typeof prop === "string") recordRead(prop);
      return Reflect.get(target, prop, receiver);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string") recordRead(prop);
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    has(target, prop) {
      if (typeof prop === "string") recordRead(prop);
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      recordEnumeration();
      return Reflect.ownKeys(target);
    },
  });
}

function createThenableParams<T extends Record<string, unknown>>(
  obj: T,
  observer: ThenableParamsObserver | undefined,
  fallbackShellState: PprFallbackShellState | null,
  options: ThenableParamsOptions | undefined,
  varyShellState: PprFallbackShellState | null,
): ThenableParams<T> {
  const plain = { ...obj };
  // A shell that records its vary params records each read: search params as
  // `?`, as Next.js's `createVaryingSearchParams` does.
  const varyShell = varyShellState?.varyParams ? varyShellState : null;
  // A well-known key reads the promise, unless the resolved values hold it.
  const recordVaryRead = (key: string) => {
    if (varyShell === null || (isWellKnownProperty(key) && !hasParamProperty(plain, key))) return;
    recordPprFallbackShellVaryParams(varyShell, [options?.isSearchParams ? "?" : key]);
  };
  const recordVaryEnumeration = () => {
    if (varyShell === null) return;
    recordPprFallbackShellVaryParams(
      varyShell,
      options?.isSearchParams
        ? ["?"]
        : [...Object.keys(plain), ...getOptionalCatchAllParamNames(varyShell.routePattern)],
    );
  };
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
    // fire on the first continuation or fallback-key access.
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

  const promise = Promise.resolve(
    varyShell === null ? plain : createVaryingParams(plain, recordVaryRead, recordVaryEnumeration),
  );

  function isFallbackParam(prop: PropertyKey): boolean {
    return typeof prop === "string" && (fallbackParamNames?.has(prop) ?? false);
  }

  const handler: ProxyHandler<Promise<T>> = {
    get(target, prop, receiver) {
      if (isPromiseContinuation(prop)) {
        if (prop === "then") observer?.observeThenRead?.();
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (prop !== "then") observer?.observeThenRead?.();
          // Like Next.js's `makeHangingParams`, awaiting params that hold a
          // fallback key never resolves while the shell prerenders, so a
          // continuation (`params.then(p => p.slug)`, or an async helper that
          // awaits them) stays pending instead of rejecting with the
          // suspension.
          const hangingParams = getFallbackShellPromise();
          if (hangingParams) return Reflect.apply(value, hangingParams, args);
          try {
            observeAllParamKeys(observer, plain);
          } catch (error) {
            // Reject like a native promise instead of throwing. React counts
            // a pending chunk before it calls `then` (when it serializes a
            // promise prop, and when its dev build serializes component
            // props), so a synchronous throw leaves that chunk open and the
            // stream never closes.
            return Reflect.apply(value, Promise.reject(error), args);
          }
          return Reflect.apply(value, target, args);
        };
      }

      if (prop === "reason" && Object.hasOwn(target, prop)) {
        // React writes a rejected thenable's `reason` onto it and reads it back
        // after counting a pending chunk. Like Next.js, return what React
        // wrote without counting a param access.
        return Reflect.get(target, prop);
      }

      if (typeof prop === "string" && !isWellKnownProperty(prop)) {
        observeParamKeys(observer, [prop]);
        recordVaryRead(prop);
      }

      if (!isWellKnownProperty(prop) && hasParamProperty(plain, prop)) {
        if (isFallbackParam(prop)) {
          const p = getFallbackShellPromise();
          if (p) throw p;
        }
        return Reflect.get(plain, prop);
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      // Own-property checks answer through the traps below, so they see (and
      // observe) the param keys, as `Object.prototype.hasOwnProperty.call`
      // does.
      return value.bind(isOwnPropertyCheck(prop) ? receiver : target);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && !isWellKnownProperty(prop)) {
        observeParamKeys(observer, [prop]);
        recordVaryRead(prop);
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
        recordVaryRead(prop);
      }

      return (
        Reflect.has(target, prop) || (!isWellKnownProperty(prop) && hasParamProperty(plain, prop))
      );
    },
    ownKeys() {
      observeReadableParamKeys(observer, plain);
      recordVaryEnumeration();
      return Reflect.ownKeys(plain).filter((prop) => !isWellKnownProperty(prop));
    },
    set(target, prop, value) {
      // Write straight to the promise. Without this trap, a write such as
      // React's `thenable.reason = error` reads the descriptor through the
      // getOwnPropertyDescriptor trap and counts as a param access, which can
      // throw inside React's settle callback.
      return Reflect.set(target, prop, value);
    },
  };

  const params = createThenableParamsProxy(promise, handler);
  paramsState.set(params, {
    plain,
    observer,
    fallbackShellState: fallbackParamNames ? fallbackShellState : null,
    options,
    varyShellState: varyShell,
  });
  return params;
}
