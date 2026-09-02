/** Cacheable Pages render/API stage. This is the only Pages Worker stage that imports user pages. */

import { runWithExecutionContext, type ExecutionContextLike } from "vinext/shims/request-context";
import { createWorkerRevalidationContext } from "./worker-revalidation-context.js";
import {
  isPagesResponseStageProps,
  PAGES_RESPONSE_STAGE_POLICY_OWNER_HEADER,
  type WorkerResponseStageProps,
} from "./worker-stages.js";
import type {
  VinextRequestStageTransport,
  VinextResponseStageDispatchOptions,
} from "./multi-stage.js";
import { withResponseStageCacheability } from "./response-stage-cacheability.js";
import {
  applyResponseStagePolicyHeaders,
  stripInheritedResponseStageCookies,
} from "./response-stage-policy.js";
import { beginRouteCacheability } from "vinext/shims/cacheability-classification";
import { preserveFullyBufferedBodyMetadata } from "vinext/shims/unified-request-context";
import { validateCdnRequest } from "./cache-control.js";
import { createWorkerPrerenderReadinessResponse } from "./worker-prerender-discovery.js";

// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";
// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredImageOptimizer } from "virtual:vinext-image-adapters";
// Response-only generated entry: page/API modules and rendering, without the
// user middleware module or request-stage routing runtime.
// @ts-expect-error -- virtual module resolved by vinext at build time
import * as pagesEntry from "virtual:vinext-pages-response-entry";
// @ts-expect-error -- virtual module resolved by vinext at build time
import __cacheabilityManifest from "virtual:vinext-cacheability-manifest";

type PagesWorkerEnv = Record<string, unknown>;

type PagesWorkerExecutionContext = ExecutionContextLike & {
  cache?: unknown;
};

type PagesStreamedHtmlResponse = Response & {
  __vinextStreamedHtmlResponse?: boolean;
};

/** Remove a body length inherited from response staging before transport drops the stream tag. */
function stripStreamedHtmlContentLength(response: Response): Response {
  if (
    (response as PagesStreamedHtmlResponse).__vinextStreamedHtmlResponse !== true ||
    !response.headers.has("Content-Length")
  ) {
    return response;
  }
  try {
    response.headers.delete("Content-Length");
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.delete("Content-Length");
    const stripped = preserveFullyBufferedBodyMetadata(
      response,
      new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      }),
    ) as PagesStreamedHtmlResponse;
    stripped.__vinextStreamedHtmlResponse = true;
    return stripped;
  }
}

async function renderPagesResponse(
  request: Request,
  env: PagesWorkerEnv | undefined,
  platformCtx: PagesWorkerExecutionContext | undefined,
  props: WorkerResponseStageProps,
  stagedHeaders?: Headers,
  dispatchRequestStage?: VinextRequestStageTransport,
  dispatchOptions: VinextResponseStageDispatchOptions = { cache: "bypass" },
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

  registerConfiguredImageOptimizer(env);
  const renderHeaders = new Headers(stagedHeaders ?? props.stagedHeaders ?? []);
  // A request-stage Content-Length describes neither the page nor API body.
  // Do not expose it as response-owned state; user code can still set its own.
  renderHeaders.delete("Content-Length");
  const initialResponseHeaders = new Headers(renderHeaders);
  // Legacy/local callers may supply policy metadata without a staged snapshot.
  // Keep that fallback while treating policy as admission provenance rather
  // than the transport for the response state visible to Pages user code.
  if (props.stagedHeaders === null && stagedHeaders === undefined) {
    applyResponseStagePolicyHeaders(initialResponseHeaders, props.cacheability.policyHeaders);
    applyResponseStagePolicyHeaders(renderHeaders, props.cacheability.policyHeaders);
  }
  let ctx = createWorkerRevalidationContext(
    platformCtx,
    (internalRequest) => {
      if (!dispatchRequestStage) {
        throw new Error("Pages response stage requires a request-stage dispatcher");
      }
      return dispatchRequestStage(internalRequest);
    },
    "node",
  );
  if (props.kind === "pages-prerender-discovery") {
    ctx = { ...ctx, isPrerenderPathDiscovery: true };
  }
  const render = async (cacheabilityContext: ExecutionContextLike): Promise<Response> => {
    if (props.kind === "pages-prerender-discovery") {
      const readinessResponse = createWorkerPrerenderReadinessResponse(
        cacheabilityContext,
        request,
      );
      if (readinessResponse) {
        return (await validateCdnRequest(request)) ?? readinessResponse;
      }
      const { handleAppPrerenderEndpoint } = await import("./app-prerender-endpoints.js");
      const response = await runWithExecutionContext(cacheabilityContext, () =>
        handleAppPrerenderEndpoint(request, {
          isPrerenderEnabled: () => true,
          loadPagesRoutes: async () => pagesEntry.pageRoutes,
          pathname: new URL(request.url).pathname,
          staticParamsMap: {},
        }),
      );
      return response ?? new Response("This page could not be found", { status: 404 });
    }
    if (props.kind === "pages-api") {
      if (typeof pagesEntry.handleApiRoute !== "function") {
        return new Response("This page could not be found", { status: 404 });
      }
      return runWithExecutionContext(cacheabilityContext, () => {
        beginRouteCacheability("pages-api", props.cacheability.resolvedRoutePathname);
        return pagesEntry.handleApiRoute(
          request,
          props.apiUrl,
          cacheabilityContext,
          new URL(request.url).origin,
          cacheabilityContext.hostRuntime ?? "node",
          initialResponseHeaders,
        );
      });
    }
    if (typeof pagesEntry.renderPage !== "function") {
      return new Response("This page could not be found", { status: 404 });
    }
    return stripStreamedHtmlContentLength(
      await pagesEntry.renderPage(
        request,
        props.resolvedUrl,
        null,
        cacheabilityContext,
        renderHeaders,
        props.renderOptions ?? undefined,
        initialResponseHeaders,
      ),
    );
  };
  const handle = async (cacheabilityContext: ExecutionContextLike): Promise<Response> =>
    stripInheritedResponseStageCookies(await render(cacheabilityContext), renderHeaders);
  const response = await withResponseStageCacheability(
    {
      buildId: pagesEntry.buildId,
      cache: props.kind === "pages-prerender-discovery" ? "bypass" : dispatchOptions.cache,
      context: ctx,
      policyHeaders: props.cacheability.policyHeaders,
      policyHeadersAppliedBeforeRender: true,
      probeMode: props.cacheability.probeMode,
      rawManifest: __cacheabilityManifest,
      registerCacheAdapters: () => registerConfiguredCacheAdapters(env),
      request,
      representation: props.cacheability.representation,
      resolvedRoutePathname: props.cacheability.resolvedRoutePathname,
    },
    handle,
  );
  if (props.kind !== "pages-page") return response;

  const runtimeDataKind = pagesEntry.getRuntimePageDataKind(props.resolvedUrl, request);
  const headers = new Headers(response.headers);
  headers.set(
    PAGES_RESPONSE_STAGE_POLICY_OWNER_HEADER,
    runtimeDataKind === "server" || runtimeDataKind === "initial" ? "request-time" : "static",
  );
  return preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
}

export function handleResponseStage(
  request: Request,
  env: PagesWorkerEnv | undefined,
  ctx: PagesWorkerExecutionContext | undefined,
  props: WorkerResponseStageProps,
  dispatchRequestStage: VinextRequestStageTransport,
  options: VinextResponseStageDispatchOptions,
): Promise<Response> {
  return renderPagesResponse(request, env, ctx, props, undefined, dispatchRequestStage, options);
}
