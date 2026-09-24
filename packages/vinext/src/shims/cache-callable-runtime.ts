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
 * promises were and decoding restores the same shape. Maps and Sets that lead
 * to params are recorded the same way so their members can be restored.
 */
type EncodedCacheArguments = {
  args: unknown[];
  encodedValuePaths: ValuePath[];
};

/**
 * A value split for Flight. For a promise-augmented object, the own fields
 * build the cache key and the promise carries the resolved value, which can
 * differ: the params proxy hides params named like promise or React fields
 * (`value`, `status`) from its own keys but still resolves to them.
 */
type EncodedValue =
  | { kind: "thenable"; fields: Record<string, unknown>; promise: PromiseLike<unknown> }
  | { kind: "map"; entries: Array<[unknown, unknown]> }
  | { kind: "set"; values: unknown[] };

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

/** Values whose members Flight serializes, so they can lead to params. */
function isContainer(value: object): boolean {
  return (
    isThenableObject(value) ||
    Array.isArray(value) ||
    value instanceof Map ||
    value instanceof Set ||
    isPlainRecord(value)
  );
}

function containerMembers(value: object): unknown[] {
  if (value instanceof Map) return [...value].flat();
  if (value instanceof Set) return [...value];
  return Object.keys(value).map((key) => Reflect.get(value, key));
}

/**
 * Find the containers that lead to a promise-augmented object. Everything
 * else is passed to Flight as-is, so Flight keeps its shared references,
 * including ones between a params object's fields and its resolved value.
 */
function findValuesToEncode(args: unknown[]): Set<object> {
  const referrers = new Map<object, object[]>();
  const pending: object[] = [];
  const visit = (value: unknown, referrer: object | undefined): void => {
    if (typeof value !== "object" || value === null || !isContainer(value)) return;
    const known = referrers.get(value);
    if (known) {
      if (referrer) known.push(referrer);
      return;
    }
    referrers.set(value, referrer ? [referrer] : []);
    if (isThenableObject(value)) pending.push(value);
    for (const member of containerMembers(value)) visit(member, value);
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

/**
 * Split promise-augmented objects into fields and promise, and the Maps and
 * Sets that contain them into their members, recording each location.
 */
export function encodeCacheArguments(args: unknown[]): EncodedCacheArguments {
  const toEncode = findValuesToEncode(args);
  const encodedValuePaths: ValuePath[] = [];
  const path: ValuePath = [];
  // Flight preserves shared references and cycles, so each source object maps
  // to one encoded value, created before its members are encoded.
  const encoded = new Map<object, unknown>();
  const encodeAt = (value: unknown, ...segments: ValuePath): unknown => {
    path.push(...segments);
    try {
      return encode(value);
    } finally {
      path.length -= segments.length;
    }
  };
  const encode = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || !toEncode.has(value)) return value;
    const isThenableValue = isThenableObject(value);
    // Each location of a shared encoded value is restored.
    if (isThenableValue || value instanceof Map || value instanceof Set) {
      encodedValuePaths.push([...path]);
    }
    if (encoded.has(value)) return encoded.get(value);
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      encoded.set(value, items);
      for (let index = 0; index < value.length; index++) {
        items[index] = encodeAt(value[index], index);
      }
      return items;
    }
    if (value instanceof Map) {
      const entries: Array<[unknown, unknown]> = [];
      encoded.set(value, { kind: "map", entries } satisfies EncodedValue);
      for (const [key, item] of value) {
        const index = entries.length;
        entries.push([encodeAt(key, "entries", index, 0), encodeAt(item, "entries", index, 1)]);
      }
      return encoded.get(value);
    }
    if (value instanceof Set) {
      const values: unknown[] = [];
      encoded.set(value, { kind: "set", values } satisfies EncodedValue);
      for (const item of value) values.push(encodeAt(item, "values", values.length));
      return encoded.get(value);
    }
    const fields: Record<string, unknown> = {};
    const result = isThenableValue
      ? ({ kind: "thenable", fields, promise: value } satisfies EncodedValue)
      : fields;
    encoded.set(value, result);
    const prefix: ValuePath = isThenableValue ? ["fields"] : [];
    for (const key of Object.keys(value)) {
      fields[key] = encodeAt(Reflect.get(value, key), ...prefix, key);
    }
    return result;
  };
  return { args: encode(args) as unknown[], encodedValuePaths };
}

/** Restore the argument shapes that `encodeCacheArguments` captured before Flight encoding. */
export function decodeCacheArguments(value: unknown): unknown[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("args" in value) ||
    !Array.isArray(value.args) ||
    !("encodedValuePaths" in value) ||
    !Array.isArray(value.encodedValuePaths)
  ) {
    throw new Error("Invalid cache function arguments");
  }
  const args = adoptFlightThenables(value.args) as unknown[];
  // Paths run through encoded values, so every location is found before any
  // is replaced.
  const locations = value.encodedValuePaths.map((path: unknown) => locateEncodedValue(args, path));
  // Every location of a shared encoded value restores the same value.
  const restored = new Map<EncodedValue, object>();
  for (const { encoded } of locations) {
    if (!restored.has(encoded)) restored.set(encoded, createRestoredValue(encoded));
  }
  for (const { parent, key, encoded } of locations) {
    Reflect.set(parent, key, restored.get(encoded));
  }
  // Members are copied once every location is replaced, so members that are
  // encoded values themselves, including cycles, are already restored.
  for (const [encoded, target] of restored) fillRestoredValue(encoded, target);
  return args;
}

function isPathSegment(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function locateEncodedValue(
  args: unknown[],
  path: unknown,
): { parent: object; key: string | number; encoded: EncodedValue } {
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
  if (typeof parent !== "object" || parent === null || !isEncodedValue(encoded)) {
    throw new Error("Invalid cache function arguments");
  }
  return { parent, key, encoded };
}

function isEncodedValue(value: unknown): value is EncodedValue {
  if (typeof value !== "object" || value === null || !isPlainRecord(value)) return false;
  switch (value.kind) {
    case "thenable": {
      const { fields, promise } = value;
      return (
        typeof fields === "object" &&
        fields !== null &&
        isPlainRecord(fields) &&
        promise instanceof Promise
      );
    }
    case "map":
      return (
        Array.isArray(value.entries) &&
        value.entries.every((entry: unknown) => Array.isArray(entry) && entry.length === 2)
      );
    case "set":
      return Array.isArray(value.values);
    default:
      return false;
  }
}

function createRestoredValue(encoded: EncodedValue): object {
  switch (encoded.kind) {
    case "thenable":
      // The promise was adopted by `adoptFlightThenables`, so it is owned here.
      return encoded.promise;
    case "map":
      return new Map();
    case "set":
      return new Set();
  }
}

function fillRestoredValue(encoded: EncodedValue, target: object): void {
  if (encoded.kind === "thenable") {
    Object.assign(target, encoded.fields);
  } else if (encoded.kind === "map" && target instanceof Map) {
    for (const [key, item] of encoded.entries) target.set(key, item);
  } else if (encoded.kind === "set" && target instanceof Set) {
    for (const item of encoded.values) target.add(item);
  }
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
