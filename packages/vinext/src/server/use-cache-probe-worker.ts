/**
 * "use cache" probe worker entry point.
 *
 * Runs in a Node.js worker_thread. Re-imports the user module with a fresh
 * ESM scope, rebuilds a minimal request ALS context from the forwarded
 * snapshot, and executes the cached function. Posts `{ completed: true }` if
 * the function resolves, `{ completed: false }` or `{ error: string }`
 * otherwise.
 *
 * The fresh module scope is achieved by appending `?v=probe-<timestamp>` to
 * the module URL, bypassing the Node.js ESM cache for that import.
 */

import { parentPort } from "node:worker_threads";
import { runWithPrivateCache } from "vinext/shims/cache-runtime";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";
import { headersContextFromRequest } from "vinext/shims/headers";

type ProbeMessage = {
  id: number;
  modulePath: string;
  functionId: string;
  variant: string;
  encodedArguments: string;
  request: {
    headers: [string, string][];
    cookieHeader: string | undefined;
    urlPathname: string;
    urlSearch: string;
    rootParams: Record<string, string | string[]>;
    isDraftMode: boolean;
    isHmrRefresh: boolean;
  };
  timeoutMs: number;
};

if (!parentPort) {
  throw new Error("use-cache-probe-worker must be run inside a worker_thread");
}

function postCompleted(id: number, completed: boolean): void {
  parentPort!.postMessage({ id, completed });
}

function postError(id: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  parentPort!.postMessage({ id, error: message });
}

parentPort.on("message", async (msg: ProbeMessage) => {
  const { id, modulePath, functionId, encodedArguments, request, timeoutMs } = msg;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Re-import with a fresh ESM cache via query suffix.
    const freshUrl = `${modulePath}?v=probe-${Date.now()}`;
    const mod = await import(freshUrl);

    // Resolve the cached wrapper. In the transformed code the export is
    // wrapped with registerCachedFunction(..., id, variant). The wrapper is
    // usually the default export or a named export matching the original
    // function name. We try the most common patterns.
    let wrappedFn: ((...args: unknown[]) => Promise<unknown>) | undefined;

    // Try to find a function whose internal id matches.
    for (const key of Object.keys(mod)) {
      const val = mod[key];
      if (
        typeof val === "function" &&
        (val as Record<string, unknown>).__vinextCacheId === functionId
      ) {
        wrappedFn = val as (...args: unknown[]) => Promise<unknown>;
        break;
      }
    }

    // Fallback: if the module re-exported the wrapper under the original name
    if (!wrappedFn) {
      const exportName = functionId.split(":").pop() ?? "default";
      wrappedFn = mod[exportName] ?? mod.default;
    }

    if (typeof wrappedFn !== "function") {
      postCompleted(id, false);
      return;
    }

    // Decode arguments. The probe uses the stable-stringify JSON form that
    // cache-runtime.ts produces when RSC encodeReply is unavailable, or the
    // string form of encodeReply output.
    let args: unknown[];
    try {
      args = JSON.parse(encodedArguments);
    } catch {
      // If encodedArguments is not JSON (e.g. it came from encodeReply as a
      // string cache key), treat it as a single string argument.
      args = [encodedArguments];
    }

    // Rebuild a minimal request context from the snapshot so private caches
    // that read cookies/headers resolve correctly.
    const headers = new Headers(request.headers);
    const headersContext = headersContextFromRequest(
      new Request(`http://localhost${request.urlPathname}${request.urlSearch}`, {
        headers,
      }),
    );
    const requestContext = createRequestContext({
      headersContext,
      executionContext: null,
      unstableCacheRevalidation: "foreground",
    });

    // Run inside a private-cache ALS scope so "use cache: private" behaves
    // the same as in the main render.
    const result = await runWithRequestContext(requestContext, () =>
      runWithPrivateCache(async () => {
        // If the abort signal fires, turn it into a rejection so the caller
        // sees it as a probe timeout (inconclusive).
        const abortPromise = new Promise<never>((_, reject) => {
          if (controller.signal.aborted) {
            reject(new Error("Probe aborted by timeout"));
          } else {
            controller.signal.addEventListener(
              "abort",
              () => reject(new Error("Probe aborted by timeout")),
              {
                once: true,
              },
            );
          }
        });
        return Promise.race([wrappedFn!(...args), abortPromise]);
      }),
    );

    clearTimeout(timer);
    postCompleted(id, true);
    void result; // result is not used, we only care that it resolved
  } catch (error) {
    postError(id, error);
  }
});
