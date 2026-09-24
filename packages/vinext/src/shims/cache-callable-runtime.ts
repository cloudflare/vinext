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

type ValuePath = Array<string | number>;

/**
 * Flight serializes a promise as its resolved value and drops its own fields.
 * Next.js params are promises that also expose their resolved fields, and the
 * cache key is built from those fields, so the payload records where such
 * promises were and decoding restores the same shape.
 */
type EncodedCacheArguments = {
  args: unknown[];
  thenableObjectPaths: ValuePath[];
};

/**
 * A promise-augmented object split for Flight. The own fields build the cache
 * key; the promise carries the resolved value, which can differ: the params
 * proxy hides params named like promise or React fields (`value`, `status`)
 * from its own keys but still resolves to them.
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

function encryptCacheArguments(args: unknown[]): Promise<string> {
  return encryptActionBoundArgs(encodeCacheArguments(args));
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

/**
 * Find the arrays and plain records that lead to a promise-augmented object.
 * Everything else is passed to Flight as-is, so Flight keeps its shared
 * references, including ones between a params object's fields and its
 * resolved value.
 */
function findValuesToEncode(args: unknown[]): Set<object> {
  const referrers = new Map<object, object[]>();
  const pending: object[] = [];
  const visit = (value: unknown, referrer: object | undefined): void => {
    if (typeof value !== "object" || value === null) return;
    const isThenableValue = isThenableObject(value);
    if (!isThenableValue && !Array.isArray(value) && !isPlainRecord(value)) return;
    const known = referrers.get(value);
    if (known) {
      if (referrer) known.push(referrer);
      return;
    }
    referrers.set(value, referrer ? [referrer] : []);
    if (isThenableValue) pending.push(value);
    for (const key of Object.keys(value)) visit(Reflect.get(value, key), value);
  };
  visit(args, undefined);

  const toEncode = new Set<object>();
  for (let value = pending.pop(); value; value = pending.pop()) {
    if (toEncode.has(value)) continue;
    toEncode.add(value);
    pending.push(...(referrers.get(value) ?? []));
  }
  return toEncode;
}

/** Split promise-augmented objects into fields and promise, recording each location. */
export function encodeCacheArguments(args: unknown[]): EncodedCacheArguments {
  const toEncode = findValuesToEncode(args);
  const thenableObjectPaths: ValuePath[] = [];
  const path: ValuePath = [];
  // Flight preserves shared references and cycles, so each source object maps
  // to one encoded value, created before its children are encoded.
  const encoded = new Map<object, unknown>();
  const encodeAt = (segment: string | number, value: unknown): unknown => {
    path.push(segment);
    try {
      return encode(value);
    } finally {
      path.pop();
    }
  };
  const encode = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || !toEncode.has(value)) return value;
    const isThenableValue = isThenableObject(value);
    if (encoded.has(value)) {
      // Each location of a shared promise-augmented object is restored.
      if (isThenableValue) thenableObjectPaths.push([...path]);
      return encoded.get(value);
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      encoded.set(value, items);
      for (let index = 0; index < value.length; index++)
        items[index] = encodeAt(index, value[index]);
      return items;
    }
    const fields: Record<string, unknown> = {};
    const result = isThenableValue
      ? ({ fields, promise: value } satisfies EncodedThenableObject)
      : fields;
    encoded.set(value, result);
    if (isThenableValue) path.push("fields");
    for (const key of Object.keys(value)) fields[key] = encodeAt(key, Reflect.get(value, key));
    if (isThenableValue) {
      path.pop();
      // Recorded after nested locations so decoding restores inner objects
      // before an enclosing promise copies their references.
      thenableObjectPaths.push([...path]);
    }
    return result;
  };
  return { args: encode(args) as unknown[], thenableObjectPaths };
}

/** Restore the argument shapes that `encodeCacheArguments` captured before Flight encoding. */
export function decodeCacheArguments(value: unknown): unknown[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("args" in value) ||
    !Array.isArray(value.args) ||
    !("thenableObjectPaths" in value) ||
    !Array.isArray(value.thenableObjectPaths)
  ) {
    throw new Error("Invalid cache function arguments");
  }
  const args = adoptFlightThenables(value.args) as unknown[];
  for (const path of value.thenableObjectPaths) restoreThenableObject(args, path);
  return args;
}

function isPathSegment(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function restoreThenableObject(args: unknown[], path: unknown): void {
  if (!Array.isArray(path) || path.length === 0 || !path.every(isPathSegment)) {
    throw new Error("Invalid cache function arguments");
  }
  let parent: unknown = args;
  for (const segment of path.slice(0, -1)) {
    parent = typeof parent === "object" && parent !== null ? Reflect.get(parent, segment) : null;
  }
  const key = path[path.length - 1];
  const encoded: unknown =
    typeof parent === "object" && parent !== null ? Reflect.get(parent, key) : null;
  if (typeof parent !== "object" || parent === null || !isEncodedThenableObject(encoded)) {
    throw new Error("Invalid cache function arguments");
  }
  // The promise was adopted by `adoptFlightThenables`, so it is owned here.
  // Every location of a shared object restores the same promise.
  Reflect.set(parent, key, Object.assign(encoded.promise, encoded.fields));
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
  if (!Array.isArray(value) && !isPlainRecord(value)) return value;
  adopted.set(value, value);
  // Decoded Flight values are owned by this call, so update them in place.
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
