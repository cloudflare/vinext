/** Cacheable App response stage. This is the only multi-stage App entry that imports user routes. */

import rscHandler from "virtual:vinext-app-response-entry";
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
  registerConfiguredCacheAdapters(env);
  registerConfiguredImageOptimizer(env);
  const ctx = createWorkerRevalidationContext(
    platformCtx,
    (internalRequest) => dispatchRequestStage(internalRequest),
    "node",
  );
  if (props.kind === "app-full-request") {
    const currentBuildId = process.env.__VINEXT_BUILD_ID ?? null;
    if (props.buildId !== currentBuildId) {
      return new Response("Incompatible vinext App response stage", { status: 409 });
    }
    const fullEntry = await import("virtual:vinext-rsc-entry");
    const render = () => fullEntry.default(request, ctx);
    return serializeStaticFileSignalForTransport(
      await runWithExecutionContext(ctx, render),
      props.staticFileSignalToken,
    );
  }
  const render = () => rscHandler.handleResponseStage(request, ctx, props, options);
  return runWithExecutionContext(ctx, render);
}
