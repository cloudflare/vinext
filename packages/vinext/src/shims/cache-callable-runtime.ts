import {
  decryptActionBoundArgs,
  encryptActionBoundArgs,
} from "@vitejs/plugin-rsc/utils/encryption-runtime";
import {
  registerCachedFunction as registerCachedFunctionBase,
  type RegisterCachedFunctionOptions,
} from "./cache-runtime.js";

const CACHE_CAPTURE_TYPE = "use-cache-captures";

type CacheCaptureEnvelope = {
  type: typeof CACHE_CAPTURE_TYPE;
  encrypted: string | PromiseLike<string>;
};

export function encryptCacheCaptures(captures: unknown[]): CacheCaptureEnvelope {
  return {
    type: CACHE_CAPTURE_TYPE,
    encrypted: encryptActionBoundArgs(captures),
  };
}

async function decryptCacheCaptures(value: unknown): Promise<unknown[] | undefined> {
  if (!isCacheCaptureEnvelope(value)) return;
  const captures = await decryptActionBoundArgs(Promise.resolve(value.encrypted));
  if (!Array.isArray(captures)) throw new Error("Invalid cache capture payload");
  return captures;
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
  });
}
