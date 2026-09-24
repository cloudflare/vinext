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

/** Replace promise-augmented objects with their own fields, recording each location. */
export function encodeCacheArguments(args: unknown[]): EncodedCacheArguments {
  const thenableObjectPaths: ValuePath[] = [];
  const active = new Set<object>();
  const encode = (value: unknown, path: ValuePath): unknown => {
    if (typeof value !== "object" || value === null || active.has(value)) return value;
    const isThenableObject = isThenable(value) && Object.keys(value).length > 0;
    if (!isThenableObject && !Array.isArray(value) && !isPlainRecord(value)) return value;

    active.add(value);
    try {
      if (Array.isArray(value)) {
        const items = value.map((item, index) => encode(item, [...path, index]));
        return items.some((item, index) => item !== value[index]) ? items : value;
      }
      let changed = isThenableObject;
      const fields: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const field: unknown = Reflect.get(value, key);
        fields[key] = encode(field, [...path, key]);
        if (fields[key] !== field) changed = true;
      }
      // Recorded after nested locations so decoding restores inner objects
      // before an enclosing promise copies their references.
      if (isThenableObject) thenableObjectPaths.push(path);
      return changed ? fields : value;
    } finally {
      active.delete(value);
    }
  };
  return { args: encode(args, []) as unknown[], thenableObjectPaths };
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
  const fields: unknown =
    typeof parent === "object" && parent !== null ? Reflect.get(parent, key) : null;
  if (
    typeof parent !== "object" ||
    parent === null ||
    typeof fields !== "object" ||
    fields === null ||
    !isPlainRecord(fields)
  ) {
    throw new Error("Invalid cache function arguments");
  }
  // Same construction as the params promises the framework passes to pages.
  Reflect.set(parent, key, Object.assign(Promise.resolve(fields), fields));
}

/**
 * Flight decodes promises as React chunks whose own fields are React's
 * internal state. Adopt them into native promises, which have no own fields,
 * so key serialization sees a promise exactly as the original call did.
 */
function adoptFlightThenables(value: unknown, active = new Set<object>()): unknown {
  if (typeof value !== "object" || value === null || active.has(value)) return value;
  if (isThenable(value)) {
    const adopted = Promise.resolve(value).then((resolved) => adoptFlightThenables(resolved));
    // A React chunk never reports an unobserved rejection; keep that behavior.
    adopted.catch(() => {});
    return adopted;
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) return value;
  active.add(value);
  // Decoded Flight values are owned by this call, so update them in place.
  for (const key of Object.keys(value)) {
    Reflect.set(value, key, adoptFlightThenables(Reflect.get(value, key), active));
  }
  active.delete(value);
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
    (typeof encrypted === "object" &&
      encrypted !== null &&
      "then" in encrypted &&
      typeof encrypted.then === "function")
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
