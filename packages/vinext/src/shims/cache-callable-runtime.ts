import {
  decryptActionBoundArgs,
  encryptActionBoundArgs,
} from "@vitejs/plugin-rsc/utils/encryption-runtime";
import {
  isThenableObject,
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
    encrypted: encryptCaptures(captures),
  };
}

async function decryptCacheCaptures(value: unknown): Promise<unknown[] | undefined> {
  if (!isCacheCaptureEnvelope(value)) return;
  return decryptCacheArguments(value.encrypted);
}

async function encryptCaptures(captures: unknown[]): Promise<string> {
  // Unlike invocation args, captures must always be encoded: the function
  // cannot run without them. They are decoded on every call, the original one
  // included, so they key the same way on a replay even when a getter's value
  // is not scanned; only promise fields behind a getter are lost.
  return encryptActionBoundArgs(await encodeCacheArguments(captures, "skip"));
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

/**
 * The arguments hold a getter. Flight reads it again while serializing, and a
 * getter can return a different value, such as a new promise, on every read,
 * so the recorded promise fields may not match what Flight serializes.
 */
class UnreplayableCacheArgumentsError extends Error {
  constructor() {
    super("Cache function arguments with getters cannot be replayed");
  }
}

/**
 * What to do when a read would run a getter: `reject` throws
 * `UnreplayableCacheArgumentsError`, `skip` leaves the getter unread.
 */
type GetterHandling = "reject" | "skip";

/**
 * The own entries of `value` that Flight serializes: every index below an
 * array's `length`, including holes and non-enumerable indices, as
 * `JSON.stringify` reads them, and the enumerable own keys of anything else.
 * A getter, own or inherited through an array hole, is never run.
 */
function ownEntries(value: object, getters: GetterHandling): [string, unknown][] {
  const keys = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) => String(index))
    : Object.keys(value);
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    if (readsGetter(value, key)) {
      if (getters === "reject") throw new UnreplayableCacheArgumentsError();
      continue;
    }
    entries.push([key, Reflect.get(value, key)]);
  }
  return entries;
}

/**
 * Whether reading `key` from `value` runs a getter. An array hole reads
 * through the prototype chain, which can hold an indexed data property or
 * accessor. A setter-only accessor reads as `undefined` without running code.
 */
function readsGetter(value: object, key: string): boolean {
  for (
    let target: object | null = value;
    target !== null;
    target = Reflect.getPrototypeOf(target)
  ) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (descriptor) return typeof descriptor.get === "function";
  }
  return false;
}

/** Members of the values Flight serializes recursively, which can hold params. */
function flightMembers(value: object, getters: GetterHandling): unknown[] {
  if (value instanceof Map) return [...value].flat();
  if (value instanceof Set) return [...value];
  if (isThenableObject(value) || Array.isArray(value) || isPlainRecord(value)) {
    return ownEntries(value, getters).map(([, member]) => member);
  }
  return [];
}

/**
 * Collect the own fields of every promise-augmented object in the arguments,
 * including ones inside resolved promise values. The arguments are passed to
 * Flight as they are, so Flight keeps their shared references and cycles.
 * With `getters: "reject"`, throws `UnreplayableCacheArgumentsError` when the
 * arguments hold a getter; with `"skip"`, promise fields behind a getter are
 * not recorded.
 */
export async function encodeCacheArguments(
  args: unknown[],
  getters: GetterHandling = "reject",
): Promise<EncodedCacheArguments> {
  // Flight serializes a promise as its resolved value, which can hold more
  // params. Await each promise once (Flight awaits them too, and emits
  // rejections as errors), then walk the whole graph again, since the
  // arguments can change while a promise is pending. The walk that finds no
  // new promises runs right before Flight encoding, so it records the fields
  // Flight sees.
  const settled = new Map<PromiseLike<unknown>, PromiseSettledResult<unknown>>();
  for (;;) {
    const thenableObjects: EncodedThenableObject[] = [];
    const unsettled: PromiseLike<unknown>[] = [];
    const visited = new Set<object>();
    const pending: unknown[] = [args];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== "object" || value === null || visited.has(value)) continue;
      visited.add(value);
      const children = flightMembers(value, getters);
      if (isThenableObject(value)) {
        const fields = Object.fromEntries(ownEntries(value, getters));
        thenableObjects.push({ fields, promise: value });
      }
      if (isThenable(value)) {
        const result = settled.get(value);
        if (!result) unsettled.push(value);
        else if (result.status === "fulfilled") children.push(result.value);
      }
      for (const child of children) pending.push(child);
    }
    if (unsettled.length === 0) return { args, thenableObjects };
    const results = await Promise.allSettled(unsettled);
    unsettled.forEach((thenable, index) => settled.set(thenable, results[index]));
  }
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
