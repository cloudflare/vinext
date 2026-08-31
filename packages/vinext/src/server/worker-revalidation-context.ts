import type { ExecutionContextLike } from "vinext/shims/request-context";

type PlatformExecutionContext = Partial<ExecutionContextLike>;

function deriveExecutionContext(
  base: PlatformExecutionContext | undefined,
  dispatchPagesRevalidate: (request: Request) => Promise<Response>,
  isInternalPagesRevalidation: boolean,
  cacheAdapterEnv?: Record<string, unknown>,
): ExecutionContextLike {
  return {
    waitUntil(promise) {
      if (typeof base?.waitUntil === "function") {
        base.waitUntil(promise);
      } else {
        void Promise.resolve(promise).catch(() => {});
      }
    },
    ...(typeof base?.passThroughOnException === "function"
      ? {
          passThroughOnException() {
            base.passThroughOnException?.();
          },
        }
      : {}),
    hostRuntime: "worker",
    ...(base?.cache === undefined ? {} : { cache: base.cache }),
    ...(cacheAdapterEnv === undefined ? {} : { cacheAdapterEnv }),
    ...(base?.trustedRevalidateOrigin === undefined
      ? {}
      : { trustedRevalidateOrigin: base.trustedRevalidateOrigin }),
    dispatchPagesRevalidate,
    isInternalPagesRevalidation,
  };
}

/**
 * Add a request-local, in-process Pages revalidation dispatcher to a Worker
 * execution context. Re-entering with the derived internal context preserves
 * the authenticated protocol headers while keeping ordinary inbound requests
 * on the normal header-scrubbing path.
 */
export function createWorkerRevalidationContext(
  base: PlatformExecutionContext | undefined,
  handleInternalRequest: (request: Request, ctx: ExecutionContextLike) => Promise<Response>,
  cacheAdapterEnv?: Record<string, unknown>,
): ExecutionContextLike {
  if (typeof base?.dispatchPagesRevalidate === "function") {
    if (cacheAdapterEnv === undefined || base.cacheAdapterEnv !== undefined) {
      return base as ExecutionContextLike;
    }
    return deriveExecutionContext(
      base,
      base.dispatchPagesRevalidate,
      base.isInternalPagesRevalidation === true,
      cacheAdapterEnv,
    );
  }

  const dispatchPagesRevalidate = (request: Request): Promise<Response> =>
    handleInternalRequest(
      request,
      deriveExecutionContext(base, dispatchPagesRevalidate, true, cacheAdapterEnv),
    );

  return deriveExecutionContext(base, dispatchPagesRevalidate, false, cacheAdapterEnv);
}
