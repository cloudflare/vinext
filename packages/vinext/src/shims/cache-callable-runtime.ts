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

type AccessorReads = WeakMap<object, Map<string, unknown>>;

/**
 * Enumerable own entries of `value`. A getter can return a new value, such as
 * a new promise, on every read, so each accessor is read once per encode.
 */
function ownEntries(value: object, accessorReads: AccessorReads): [string, unknown][] {
  return Object.keys(value).map((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || "value" in descriptor) return [key, Reflect.get(value, key)];
    let reads = accessorReads.get(value);
    if (!reads) {
      reads = new Map();
      accessorReads.set(value, reads);
    }
    if (!reads.has(key)) reads.set(key, Reflect.get(value, key));
    return [key, reads.get(key)];
  });
}

/** Members of the values Flight serializes recursively, which can hold params. */
function flightMembers(value: object, accessorReads: AccessorReads): unknown[] {
  if (value instanceof Map) return [...value].flat();
  if (value instanceof Set) return [...value];
  if (isThenableObject(value) || Array.isArray(value) || isPlainRecord(value)) {
    return ownEntries(value, accessorReads).map(([, member]) => member);
  }
  return [];
}

/**
 * Collect the own fields of every promise-augmented object in the arguments,
 * including ones inside resolved promise values. The arguments are passed to
 * Flight as they are, apart from copies of the values that lead to a getter,
 * so Flight keeps their shared references and cycles.
 */
export async function encodeCacheArguments(args: unknown[]): Promise<EncodedCacheArguments> {
  // Flight serializes a promise as its resolved value, which can hold more
  // params. Await each promise once (Flight awaits them too, and emits
  // rejections as errors), then walk the whole graph again, since the
  // arguments can change while a promise is pending. The walk that finds no
  // new promises runs right before Flight encoding, so it records the fields
  // Flight sees. Accessors are read once, so they cannot add a new promise on
  // every walk.
  const settled = new Map<PromiseLike<unknown>, PromiseSettledResult<unknown>>();
  const accessorReads: AccessorReads = new WeakMap();
  for (;;) {
    const thenableObjects: EncodedThenableObject[] = [];
    const unsettled: PromiseLike<unknown>[] = [];
    const parents = new Map<object, object[]>();
    const visited = new Set<object>();
    const pending: unknown[] = [args];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== "object" || value === null || visited.has(value)) continue;
      visited.add(value);
      const children = flightMembers(value, accessorReads);
      if (isThenableObject(value)) {
        const fields = Object.fromEntries(ownEntries(value, accessorReads));
        thenableObjects.push({ fields, promise: value });
      }
      if (isThenable(value)) {
        const result = settled.get(value);
        if (!result) unsettled.push(value);
        else if (result.status === "fulfilled") children.push(result.value);
      }
      // Record edges to visited values too: a back-reference makes its owner
      // an ancestor of whatever it points at, which `snapshotAccessors` needs.
      for (const child of children) {
        if (typeof child !== "object" || child === null) continue;
        const childParents = parents.get(child);
        if (childParents) childParents.push(value);
        else parents.set(child, [value]);
        pending.push(child);
      }
    }
    if (unsettled.length === 0) {
      return snapshotAccessors({ args, thenableObjects }, visited, parents, settled, accessorReads);
    }
    const results = await Promise.allSettled(unsettled);
    unsettled.forEach((thenable, index) => settled.set(thenable, results[index]));
  }
}

/**
 * Flight reads getters again while serializing, and a getter can return a
 * different value on every read. Copy the values Flight serializes that lead
 * to a getter, using the reads the walk recorded, so Flight serializes the
 * graph whose promise fields were recorded.
 */
function snapshotAccessors(
  encoded: EncodedCacheArguments,
  visited: Set<object>,
  parents: Map<object, object[]>,
  settled: Map<PromiseLike<unknown>, PromiseSettledResult<unknown>>,
  accessorReads: AccessorReads,
): EncodedCacheArguments {
  // Flight does not serialize a promise's own fields, so their getters need
  // no copies.
  const pending = [...visited].filter(
    (value) => accessorReads.has(value) && (Array.isArray(value) || isPlainRecord(value)),
  );
  if (pending.length === 0) return encoded;
  const copied = new Set<unknown>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined || copied.has(value)) continue;
    copied.add(value);
    pending.push(...(parents.get(value) ?? []));
  }

  const copies = new Map<unknown, unknown>();
  const copy = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || !copied.has(value)) return value;
    if (copies.has(value)) return copies.get(value);
    if (value instanceof Map) {
      const map = new Map();
      copies.set(value, map);
      for (const [key, item] of value) map.set(copy(key), copy(item));
      return map;
    }
    if (value instanceof Set) {
      const set = new Set();
      copies.set(value, set);
      for (const item of value) set.add(copy(item));
      return set;
    }
    if (isThenable(value)) {
      // A promise that leads to a getter only through its own fields keeps
      // its identity; one whose resolved value does is replaced.
      const result = settled.get(value);
      if (result?.status !== "fulfilled" || !copied.has(result.value)) {
        copies.set(value, value);
        return value;
      }
      let resolve: (resolved: unknown) => void = () => {};
      const promise = new Promise((settle) => {
        resolve = settle;
      });
      copies.set(value, promise);
      resolve(copy(result.value));
      return promise;
    }
    const record: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    copies.set(value, record);
    for (const [key, item] of ownEntries(value, accessorReads)) {
      Object.defineProperty(record, key, {
        configurable: true,
        enumerable: true,
        value: copy(item),
        writable: true,
      });
    }
    return record;
  };

  return {
    args: copy(encoded.args) as unknown[],
    thenableObjects: encoded.thenableObjects.map(({ fields, promise }) => ({
      fields: Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, copy(item)])),
      promise: copy(promise) as PromiseLike<unknown>,
    })),
  };
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
