/** Cacheable Pages render/API stage. This is the only Pages Worker stage that imports user pages. */

import type { ExecutionContextLike } from "vinext/shims/request-context";
import { createWorkerRevalidationContext } from "./worker-revalidation-context.js";
import { isPagesResponseStageProps, type WorkerResponseStageProps } from "./worker-stages.js";
import type {
  VinextRequestStageTransport,
  VinextResponseStageDispatchOptions,
} from "./multi-stage.js";

// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";
// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredImageOptimizer } from "virtual:vinext-image-adapters";
// Response-only generated entry: page/API modules and rendering, without the
// user middleware module or request-stage routing runtime.
// @ts-expect-error -- virtual module resolved by vinext at build time
import * as pagesEntry from "virtual:vinext-pages-response-entry";

type PagesWorkerEnv = Record<string, unknown>;

type PagesWorkerExecutionContext = ExecutionContextLike & {
  cache?: unknown;
};

export async function renderPagesResponse(
  request: Request,
  env: PagesWorkerEnv | undefined,
  platformCtx: PagesWorkerExecutionContext | undefined,
  props: WorkerResponseStageProps,
  stagedHeaders?: Headers,
  dispatchRequestStage?: VinextRequestStageTransport,
): Promise<Response> {
  if (!isPagesResponseStageProps(props)) {
    return new Response("Invalid vinext Pages response stage", { status: 400 });
  }
  if (props.buildId !== pagesEntry.buildId) {
    return new Response("Vinext Pages response stage deployment mismatch", { status: 409 });
  }
  if (props.requestHost !== new URL(request.url).host) {
    return new Response("Invalid vinext Pages response stage", { status: 400 });
  }

  registerConfiguredCacheAdapters(env);
  registerConfiguredImageOptimizer(env);
  const renderHeaders = stagedHeaders ?? new Headers(props.stagedHeaders ?? []);
  const ctx = createWorkerRevalidationContext(
    platformCtx,
    (internalRequest) => {
      if (!dispatchRequestStage) {
        throw new Error("Pages response stage requires a request-stage dispatcher");
      }
      return dispatchRequestStage(internalRequest);
    },
    "node",
  );
  const handle = async (): Promise<Response> => {
    if (props.kind === "pages-api") {
      if (typeof pagesEntry.handleApiRoute !== "function") {
        return new Response("This page could not be found", { status: 404 });
      }
      return pagesEntry.handleApiRoute(
        request,
        props.apiUrl,
        ctx,
        new URL(request.url).origin,
        ctx.hostRuntime ?? "node",
      );
    }
    if (typeof pagesEntry.renderPage !== "function") {
      return new Response("This page could not be found", { status: 404 });
    }
    return pagesEntry.renderPage(
      request,
      props.resolvedUrl,
      null,
      ctx,
      renderHeaders,
      props.renderOptions ?? undefined,
    );
  };
  return handle();
}

export function handleResponseStage(
  request: Request,
  env: PagesWorkerEnv | undefined,
  ctx: PagesWorkerExecutionContext | undefined,
  props: WorkerResponseStageProps,
  dispatchRequestStage: VinextRequestStageTransport,
  _options: VinextResponseStageDispatchOptions,
): Promise<Response> {
  return renderPagesResponse(request, env, ctx, props, undefined, dispatchRequestStage);
}
