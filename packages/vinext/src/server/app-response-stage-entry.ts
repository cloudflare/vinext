/** Cacheable App response stage. This is the only multi-stage App entry that imports user routes. */

import rscHandler, { __cacheabilityManifest } from "virtual:vinext-app-response-entry";
import { runWithExecutionContext, type ExecutionContextLike } from "vinext/shims/request-context";
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
import type {
  VinextRequestStageTransport,
  VinextResponseStageDispatchOptions,
} from "./multi-stage.js";
import { withResponseStageCacheability } from "./response-stage-cacheability.js";

type AppResponseStageEnv = Record<string, unknown>;

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
        const currentBuildId = process.env.__VINEXT_BUILD_ID ?? null;
        if (props.buildId !== currentBuildId) {
          return new Response("Incompatible vinext App response stage", { status: 409 });
        }
        const fullEntry = await import("virtual:vinext-rsc-entry");
        const render = () => fullEntry.default(request, cacheabilityContext);
        return serializeStaticFileSignalForTransport(
          await runWithExecutionContext(cacheabilityContext, render),
          props.staticFileSignalToken,
        );
      }
      const render = () =>
        rscHandler.handleResponseStage(request, cacheabilityContext, props, options);
      return runWithExecutionContext(cacheabilityContext, render);
    },
  );
}
