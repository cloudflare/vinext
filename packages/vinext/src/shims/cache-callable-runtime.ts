import {
  decryptActionBoundArgs,
  encryptActionBoundArgs,
} from "@vitejs/plugin-rsc/utils/encryption-runtime";
import { renderToReadableStream, createFromReadableStream } from "@vitejs/plugin-rsc/react/rsc";
import {
  isUseCacheFunction,
  memoizeInCacheScope,
  replayCachedFunction,
  registerCachedFunction as registerCachedFunctionBase,
  type RegisterCachedFunctionOptions,
} from "./cache-runtime.js";
import {
  snapshotFlightReply,
  restoreFlightReply,
  type CacheFlightArguments,
} from "./cache-flight-arguments.js";
import type { VinextCacheFunctionInvocation } from "../server/multi-stage.js";

const CACHE_CAPTURE_TYPE = "use-cache-captures";
type CacheCaptureEnvelope = {
  type: typeof CACHE_CAPTURE_TYPE;
  encrypted: Promise<string>;
};

async function encryptArguments(value: CacheFlightArguments): Promise<string> {
  // The encryption helper uses the result codec internally. A string preserves
  // the argument payload exactly, including File metadata and multipart order.
  return encryptActionBoundArgs(JSON.stringify(value));
}

async function decryptArguments(
  encrypted: string | PromiseLike<string>,
): Promise<CacheFlightArguments> {
  const serialized = await decryptActionBoundArgs(Promise.resolve(encrypted));
  if (typeof serialized !== "string") throw new Error("Invalid cache function arguments");
  const value = JSON.parse(serialized) as CacheFlightArguments;
  if (value?.version !== 1) throw new Error("Invalid cache function arguments");
  return value;
}

export function encryptCacheCaptures(
  referenceId: string,
  captures: unknown[],
): CacheCaptureEnvelope {
  // Inline functions allocate a fresh capture tuple on each call. Memoize its
  // values so React.cache can recognize repeated bound calls in one render.
  return memoizedCaptureEnvelope(referenceId, ...captures);
}

const memoizedCaptureEnvelope = memoizeInCacheScope(
  (referenceId: string, ...captures: unknown[]): CacheCaptureEnvelope => ({
    type: CACHE_CAPTURE_TYPE,
    encrypted: encryptCaptures(referenceId, captures),
  }),
);

async function encryptCaptures(referenceId: string, captures: unknown[]): Promise<string> {
  // Like Next.js, closure captures use the result codec, which can serialize
  // ReactNodes and global symbols. Divert only Files into native metadata
  // records via Flight's temporary-reference option; no second argument walk.
  const files = new FormData();
  let nextFileId = 0;
  const temporaryReferences = new (class extends WeakMap<object, string> {
    override get(value: object): string | undefined {
      let id = super.get(value);
      if (id === undefined && value instanceof File) {
        id = String(nextFileId++);
        super.set(value, id);
        files.append(id, value);
      }
      return id;
    }
  })();
  const stream = renderToReadableStream(captures, { temporaryReferences });
  const bytes = await new Response(stream).arrayBuffer();
  return encryptActionBoundArgs(
    JSON.stringify({
      version: 1,
      referenceId,
      result: Buffer.from(bytes).toString("base64"),
      files: await snapshotFlightReply(files),
    }),
  );
}

// Like Next.js (use-cache-wrapper.ts, `boundArgsLength`), a function that
// closes over values always decrypts its first argument into exactly that many
// captures. Anything else is rejected, never passed through as plaintext
// captures: the client must not choose the closure's server values. Like
// encryption.ts binding bound args to their action id, an envelope only
// decrypts for the reference it was made for.
async function decryptCacheCaptures(
  value: unknown,
  referenceId: string,
  captureCount: number,
): Promise<unknown[]> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== CACHE_CAPTURE_TYPE ||
    !("encrypted" in value)
  ) {
    throw new Error("Invalid cache capture arguments");
  }
  const encrypted = value.encrypted;
  if (
    typeof encrypted !== "string" &&
    !(
      typeof encrypted === "object" &&
      encrypted !== null &&
      "then" in encrypted &&
      typeof encrypted.then === "function"
    )
  ) {
    throw new Error("Invalid cache capture arguments");
  }
  const serialized = await decryptActionBoundArgs(
    Promise.resolve(encrypted as string | PromiseLike<string>),
  );
  if (typeof serialized !== "string") throw new Error("Invalid cache capture arguments");
  const payload = JSON.parse(serialized) as {
    version: number;
    referenceId: string;
    result: string;
    files: CacheFlightArguments;
  };
  if (payload.version !== 1 || payload.referenceId !== referenceId) {
    throw new Error("Invalid cache capture arguments");
  }
  const files = restoreFlightReply(payload.files);
  if (typeof files === "string") throw new Error("Invalid cache capture files");
  const captures = await createFromReadableStream<unknown>(
    new Response(Buffer.from(payload.result, "base64")).body!,
    { temporaryReferences: new Map([...files].map(([id, file]) => [`$${id}`, file])) },
    { preserveServerReferences: true },
  );
  if (!Array.isArray(captures) || captures.length !== captureCount) {
    throw new Error("Invalid cache capture arguments");
  }
  return captures;
}

export function registerCachedFunction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  id: string,
  variant: string,
  { captureCount, ...options }: RegisterCachedFunctionOptions & { captureCount?: number },
): (...args: TArgs) => Promise<TResult> {
  let decryptCaptures: RegisterCachedFunctionOptions["decryptCaptures"];
  if (captureCount !== undefined) {
    const referenceId = options.serverReferenceId;
    if (referenceId === undefined) {
      throw new Error(`Cache function ${id} has captures but no server reference`);
    }
    decryptCaptures = (value) => decryptCacheCaptures(value, referenceId, captureCount);
  }
  return registerCachedFunctionBase(fn, id, variant, {
    ...options,
    ...(decryptCaptures ? { decryptCaptures } : {}),
    encodeInvocation: encryptArguments,
  });
}

/** Replay the persisted payload without re-reading or re-encoding caller objects. */
export async function invokeCacheFunction(
  invocation: VinextCacheFunctionInvocation,
  loadServerAction: (id: string) => Promise<unknown>,
): Promise<void> {
  const fn = await loadServerAction(invocation.referenceId);
  if (!isUseCacheFunction(fn)) {
    throw new Error(`Server reference ${invocation.referenceId} is not a cache function`);
  }
  await replayCachedFunction(fn, await decryptArguments(invocation.encryptedArgs));
}
