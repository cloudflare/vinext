import {
  decryptActionBoundArgs,
  encryptActionBoundArgs,
} from "@vitejs/plugin-rsc/utils/encryption-runtime";
import {
  isUseCacheFunction,
  registerCachedFunction as registerCachedFunctionBase,
  type RegisterCachedFunctionOptions,
} from "./cache-runtime.js";
import type { VinextCacheFunctionInvocation } from "../server/multi-stage.js";

const CACHE_CAPTURE_TYPE = "use-cache-captures";

type CacheCaptureEnvelope = {
  type: typeof CACHE_CAPTURE_TYPE;
  encrypted: string | PromiseLike<string>;
};

/**
 * Flight serializes a promise as its resolved value and drops its own fields.
 * Next.js params are promises that also expose their resolved fields, and the
 * cache key is built from those fields, so the payload carries each such
 * promise's fields next to the arguments and decoding assigns them back.
 */
type EncodedCacheArguments = {
  args: unknown[];
  thenableObjects: EncodedThenableObject[];
};

/**
 * Flight writes each object once, so `promise` decodes to the same promise as
 * every other reference to it, including ones inside resolved values, and the
 * fields share references with the arguments. The fields build the cache key;
 * the resolved value can differ: the params proxy hides params named like
 * promise or React fields (`value`, `status`) from its own keys but still
 * resolves to them.
 */
type EncodedThenableObject = {
  fields: Record<string, unknown>;
  promise: PromiseLike<unknown>;
};

export function encryptCacheCaptures(captures: unknown[]): CacheCaptureEnvelope {
  return {
    type: CACHE_CAPTURE_TYPE,
    encrypted: encryptCacheArguments(captures),
  };
}

async function decryptCacheCaptures(value: unknown): Promise<unknown[] | undefined> {
  if (!isCacheCaptureEnvelope(value)) return;
  return decryptCacheArguments(value.encrypted);
}

async function encryptCacheArguments(args: unknown[]): Promise<string> {
  return encryptActionBoundArgs(await encodeCacheArguments(args));
}

async function decryptCacheArguments(encrypted: string | PromiseLike<string>): Promise<unknown[]> {
  return decodeCacheArguments(await decryptActionBoundArgs(Promise.resolve(encrypted)));
}

function isThenable(value: object): value is PromiseLike<unknown> {
  return "then" in value && typeof value.then === "function";
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && !("$$typeof" in value);
}

// Must match what `unwrapThenableObjects` in cache-runtime.ts unwraps when it
// builds the cache key.
function isThenableObject(value: object): value is PromiseLike<unknown> {
  return !Array.isArray(value) && isThenable(value) && Object.keys(value).length > 0;
}

/** Members of the values Flight serializes recursively, which can hold params. */
function flightMembers(value: object): unknown[] {
  if (value instanceof Map) return [...value].flat();
  if (value instanceof Set) return [...value];
  if (isThenableObject(value) || Array.isArray(value) || isPlainRecord(value)) {
    return Object.keys(value).map((key) => Reflect.get(value, key));
  }
  return [];
}

/**
 * Collect the own fields of every promise-augmented object in the arguments,
 * including ones inside resolved promise values. The arguments themselves are
 * passed to Flight unchanged, so Flight keeps their shared references and cycles.
 */
export async function encodeCacheArguments(args: unknown[]): Promise<EncodedCacheArguments> {
  const thenableObjects: EncodedThenableObject[] = [];
  const visited = new Set<object>();
  let pending: unknown[] = [args];
  while (pending.length > 0) {
    const thenables: PromiseLike<unknown>[] = [];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== "object" || value === null || visited.has(value)) continue;
      visited.add(value);
      if (isThenableObject(value)) {
        const fields = Object.fromEntries(
          Object.keys(value).map((key) => [key, Reflect.get(value, key)]),
        );
        thenableObjects.push({ fields, promise: value });
      }
      if (isThenable(value)) thenables.push(value);
      pending.push(...flightMembers(value));
    }
    // Flight serializes a promise as its resolved value, which can hold more
    // params. Flight awaits these promises too, and emits rejections as errors.
    const settled = await Promise.allSettled(thenables);
    pending = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }
  return { args, thenableObjects };
}

/** Restore the promise fields that `encodeCacheArguments` captured before Flight encoding. */
export function decodeCacheArguments(value: unknown): unknown[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("args" in value) ||
    !Array.isArray(value.args) ||
    !("thenableObjects" in value) ||
    !Array.isArray(value.thenableObjects)
  ) {
    throw new Error("Invalid cache function arguments");
  }
  // One traversal, so each Flight promise is adopted once across the
  // arguments and the captured fields.
  adoptFlightThenables(value);
  for (const thenableObject of value.thenableObjects) {
    if (!isEncodedThenableObject(thenableObject)) {
      throw new Error("Invalid cache function arguments");
    }
    // The promise was adopted by `adoptFlightThenables`, so it is owned here.
    Object.assign(thenableObject.promise, thenableObject.fields);
  }
  return value.args;
}

function isEncodedThenableObject(value: unknown): value is EncodedThenableObject {
  if (typeof value !== "object" || value === null || !isPlainRecord(value)) return false;
  const { fields, promise } = value;
  return (
    typeof fields === "object" &&
    fields !== null &&
    isPlainRecord(fields) &&
    promise instanceof Promise
  );
}

/**
 * Flight decodes promises as React chunks whose own fields are React's
 * internal state. Adopt them into native promises, which have no own fields,
 * so key serialization sees a promise exactly as the original call did.
 * Flight shares one chunk between references to the same promise, so each
 * chunk is adopted once, including references inside resolved values.
 */
function adoptFlightThenables(value: unknown, adopted = new WeakMap<object, unknown>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (adopted.has(value)) return adopted.get(value);
  if (isThenable(value)) {
    const promise = Promise.resolve(value).then((resolved) =>
      adoptFlightThenables(resolved, adopted),
    );
    // A React chunk never reports an unobserved rejection; keep that behavior.
    promise.catch(() => {});
    adopted.set(value, promise);
    return promise;
  }
  // Decoded Flight values are owned by this call, so update them in place.
  if (value instanceof Map) {
    adopted.set(value, value);
    const entries = [...value];
    value.clear();
    for (const [key, item] of entries) {
      value.set(adoptFlightThenables(key, adopted), adoptFlightThenables(item, adopted));
    }
    return value;
  }
  if (value instanceof Set) {
    adopted.set(value, value);
    const items = [...value];
    value.clear();
    for (const item of items) value.add(adoptFlightThenables(item, adopted));
    return value;
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) return value;
  adopted.set(value, value);
  for (const key of Object.keys(value)) {
    Reflect.set(value, key, adoptFlightThenables(Reflect.get(value, key), adopted));
  }
  return value;
}

function isCacheCaptureEnvelope(value: unknown): value is CacheCaptureEnvelope {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || value.type !== CACHE_CAPTURE_TYPE || !("encrypted" in value)) {
    return false;
  }
  const encrypted = value.encrypted;
  return (
    typeof encrypted === "string" ||
    (typeof encrypted === "object" && encrypted !== null && isThenable(encrypted))
  );
}

export function registerCachedFunction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  id: string,
  variant: string,
  options: RegisterCachedFunctionOptions,
): (...args: TArgs) => Promise<TResult> {
  return registerCachedFunctionBase(fn, id, variant, {
    ...options,
    decryptCaptures: decryptCacheCaptures,
    encodeInvocationArgs: encryptCacheArguments,
  });
}

/** Load and invoke one transformed cache function through its server-reference identity. */
export async function invokeCacheFunction(
  invocation: VinextCacheFunctionInvocation,
  loadServerAction: (id: string) => Promise<unknown>,
): Promise<void> {
  const fn = await loadServerAction(invocation.referenceId);
  if (!isUseCacheFunction(fn)) {
    throw new Error(`Server reference ${invocation.referenceId} is not a cache function`);
  }
  await fn(...(await decryptCacheArguments(invocation.encryptedArgs)));
}
