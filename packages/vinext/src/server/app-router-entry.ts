/**
 * Default Cloudflare Worker entry point for vinext App Router.
 *
 * Use this directly in wrangler.jsonc:
 *   "main": "vinext/server/app-router-entry"
 *
 * Or import and delegate to it from a custom worker:
 *   import handler from "vinext/server/app-router-entry";
 *   return handler.fetch(request, env, ctx);
 *
 * This file runs in the RSC environment. Configure the Cloudflare plugin with:
 *   cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })
 */

// @ts-expect-error — virtual module resolved by vinext
import rscHandler from "virtual:vinext-rsc-entry";
import { runWithExecutionContext, type ExecutionContextLike } from "vinext/shims/request-context";
import { resolveStaticAssetSignal } from "./worker-utils.js";
import {
  cloneRequestWithHeaders,
  filterInternalHeaders,
  isOpenRedirectShaped,
} from "./request-pipeline.js";
import { badRequestResponse, notFoundResponse } from "./http-error-responses.js";

type WorkerAssetEnv = {
  ASSETS?: {
    fetch(request: Request): Promise<Response> | Response;
  };
};

export default {
  async fetch(
    request: Request,
    env?: WorkerAssetEnv,
    ctx?: ExecutionContextLike,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Block protocol-relative URL open redirects (//evil.com/, /\evil.com/,
    // /%5Cevil.com/, /%2F/evil.com/). Check BEFORE decode so both literal and
    // percent-encoded variants are caught — encoded forms survive segment-wise
    // decoding and would otherwise reach trailing-slash redirect emitters.
    if (isOpenRedirectShaped(url.pathname)) {
      return notFoundResponse();
    }

    // Validate that percent-encoding is well-formed. The RSC handler performs
    // the actual decode + normalize; we only check here to return a clean 400
    // instead of letting a malformed sequence crash downstream.
    try {
      decodeURIComponent(url.pathname);
    } catch {
      // Malformed percent-encoding (e.g. /%E0%A4%A) — return 400 instead of throwing.
      return badRequestResponse();
    }

    // Strip internal headers from inbound requests before any handler or
    // middleware sees them. Must happen before the RSC handler runs.
    // Builds a new Headers — Request.headers is immutable in Workers.
    {
      const filteredHeaders = filterInternalHeaders(request.headers);
      request = cloneRequestWithHeaders(request, filteredHeaders);
    }

    // Do NOT decode/normalize the pathname here. The RSC handler
    // (virtual:vinext-rsc-entry) is the single point of decoding — it calls
    // decodeURIComponent + normalizePath on the incoming URL. Decoding here
    // AND in the handler would double-decode, causing inconsistent path
    // matching between middleware and routing.

    // Delegate to RSC handler (which decodes + normalizes the pathname itself),
    // wrapping in the ExecutionContext ALS scope so downstream code can reach
    // ctx.waitUntil() without having ctx threaded through every call site.
    const handleFn = () => rscHandler(request, ctx);
    const result = await (ctx ? runWithExecutionContext(ctx, handleFn) : handleFn());

    if (result instanceof Response) {
      if (env?.ASSETS) {
        const assetResponse = await resolveStaticAssetSignal(result, {
          fetchAsset: (path) =>
            Promise.resolve(env.ASSETS!.fetch(new Request(new URL(path, request.url)))),
        });
        if (assetResponse) return assetResponse;
      }
      return result;
    }

    if (result === null || result === undefined) {
      return notFoundResponse();
    }

    return new Response(String(result), { status: 200 });
  },
};
