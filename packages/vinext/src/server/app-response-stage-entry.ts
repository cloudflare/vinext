/** Cacheable App response stage. This is the only multi-stage App entry that imports user routes. */

import rscHandler, {
  __cacheabilityManifest,
  __ensureHybridPagesApplication,
  __ensureInstrumentation,
} from "virtual:vinext-app-response-entry";
import { ensureFetchPatch } from "vinext/shims/fetch-cache";
import { runWithExecutionContext, type ExecutionContextLike } from "vinext/shims/request-context";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";
// @ts-expect-error -- virtual module resolved by vinext
import { registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";
// @ts-expect-error -- virtual module resolved by vinext
import { registerConfiguredImageOptimizer } from "virtual:vinext-image-adapters";
import {
  isAppWorkerResponseStageProps,
  type AppWorkerResponseStageProps,
} from "./app-worker-stages.js";
import { serializeStaticFileSignalForTransport } from "./static-file-signal.js";
import { createWorkerRevalidationContext } from "./worker-revalidation-context.js";
import { validateCdnRequest } from "./cache-control.js";
import { createWorkerPrerenderReadinessResponse } from "./worker-prerender-discovery.js";
import type {
  VinextCacheFunctionInvocation,
  VinextRequestStageTransport,
  VinextResponseStageDispatchOptions,
} from "./multi-stage.js";
import { withResponseStageCacheability } from "./response-stage-cacheability.js";
import { serializeResponseStageLinkProvenance } from "./app-response-header-provenance.js";
import {
  attachFrameworkRequestError,
  attachFrameworkRequestRoute,
  captureFrameworkRequestRoute,
  clearFrameworkRequestError,
} from "./request-tracing.js";

type AppResponseStageEnv = Record<string, unknown>;

/** Invoke one transformed public cache function without rendering its owning route. */
export async function invokeCacheFunction(
  invocation: VinextCacheFunctionInvocation,
  env: AppResponseStageEnv | undefined,
  platformCtx: ExecutionContextLike | undefined,
  dispatchRequestStage: VinextRequestStageTransport,
): Promise<void> {
  await __ensureInstrumentation();
  const [{ loadServerAction }, { invokeCacheFunction: invokeRegisteredCacheFunction }] =
    await Promise.all([
      import("@vitejs/plugin-rsc/core/rsc"),
      import("vinext/shims/cache-callable-runtime"),
    ]);
  registerConfiguredCacheAdapters(env);
  ensureFetchPatch();
  const executionContext = createWorkerRevalidationContext(
    platformCtx,
    (request) => dispatchRequestStage(request),
    "node",
  );
  const context = createRequestContext({
    currentFetchSoftTags: invocation.softTags,
    executionContext,
    rootParams: invocation.rootParams,
  });
  await runWithRequestContext(context, () =>
    invokeRegisteredCacheFunction(invocation, loadServerAction),
  );
}

export async function handleResponseStage(
  request: Request,
  env: AppResponseStageEnv | undefined,
  platformCtx: ExecutionContextLike | undefined,
  props: AppWorkerResponseStageProps,
  dispatchRequestStage: VinextRequestStageTransport,
  options: VinextResponseStageDispatchOptions = { cache: "bypass" },
): Promise<Response> {
  if (!isAppWorkerResponseStageProps(props)) {
    return new Response("Invalid vinext App response stage", { status: 400 });
  }
  if (props.requestOrigin !== new URL(request.url).origin) {
    return new Response("Invalid vinext App response stage", { status: 400 });
  }
  const currentBuildId = process.env.__VINEXT_BUILD_ID ?? null;
  if (props.buildId !== currentBuildId) {
    return new Response("Incompatible vinext App response stage", { status: 409 });
  }
  await __ensureInstrumentation();
  if (props.kind === "app-full-request" && props.prerenderDiscovery) {
    await __ensureHybridPagesApplication();
  }
  registerConfiguredImageOptimizer(env);
  let ctx = createWorkerRevalidationContext(
    platformCtx,
    (internalRequest) => dispatchRequestStage(internalRequest),
    "node",
  );
  if (props.kind === "app-full-request" && props.prerenderDiscovery) {
    ctx = { ...ctx, isPrerenderPathDiscovery: true };
  }
  return withResponseStageCacheability(
    {
      buildId: process.env.__VINEXT_BUILD_ID,
      cache: options.cache,
      context: ctx,
      forceDynamic:
        (props.kind === "app-page" || props.kind === "app-route-handler") &&
        props.forceDynamic === true,
      policyHeaders: props.cacheability.policyHeaders,
      probeMode: props.cacheability.probeMode,
      rawManifest: __cacheabilityManifest,
      registerCacheAdapters: () => registerConfiguredCacheAdapters(env),
      request,
      representation: props.cacheability.representation,
      resolvedRoutePathname: props.cacheability.resolvedRoutePathname,
    },
    async (cacheabilityContext) => {
      if (props.kind === "app-full-request") {
        if (props.prerenderDiscovery) {
          const readinessResponse = createWorkerPrerenderReadinessResponse(
            cacheabilityContext,
            request,
          );
          if (readinessResponse) {
            return (await validateCdnRequest(request)) ?? readinessResponse;
          }
        }
        const fullEntry = await import("virtual:vinext-rsc-entry");
        const render = () =>
          fullEntry.default(
            request,
            cacheabilityContext,
            false,
            undefined,
            null,
            props.trustedPrerenderState,
          );
        let route: string | undefined;
        let result: Response;
        let failure: unknown;
        let failed = false;
        try {
          ({ result, route } = await captureFrameworkRequestRoute(
            () => runWithExecutionContext(cacheabilityContext, render),
            (matchedRoute) => {
              route = matchedRoute;
            },
          ));
        } catch (error) {
          console.error("[vinext] App response stage error:", error);
          failed = true;
          failure = error;
          result = new Response("Internal Server Error", { status: 500 });
        }
        const serialized = serializeStaticFileSignalForTransport(
          result,
          props.staticFileSignalToken,
        );
        return attachFrameworkRequestRoute(
          failed
            ? attachFrameworkRequestError(serialized, failure)
            : clearFrameworkRequestError(serialized),
          route,
        );
      }
      const render = () =>
        rscHandler.handleResponseStage(request, cacheabilityContext, props, options);
      return serializeResponseStageLinkProvenance(
        await runWithExecutionContext(cacheabilityContext, render),
      );
    },
  );
}
