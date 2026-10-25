/** Combined request/response handler used by default single-stage App entries. */

import {
  createAppRscRequestHandler,
  type AppRscHandlerRoute,
  type AppRscRequestHandler,
  type CreateAppRscHandlerOptions,
} from "./app-rsc-handler.js";
import type { AppWorkerResponseStageProps } from "./app-worker-stages.js";
import type { VinextResponseStageDispatchOptions } from "./multi-stage.js";
import { createWorkerRevalidationContext } from "./worker-revalidation-context.js";
import { getRequestExecutionContext, runWithExecutionContext } from "vinext/shims/request-context";

export type AppRscHandler = AppRscRequestHandler & {
  handleResponseStage(
    request: Request,
    ctx: unknown,
    props: AppWorkerResponseStageProps,
    options?: VinextResponseStageDispatchOptions,
  ): Promise<Response>;
};

export function createAppRscHandler<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
): AppRscHandler {
  const appRscRequestHandler = createAppRscRequestHandler(options);
  // Nitro's SSR service and @vitejs/plugin-rsc's dev and preview handlers call
  // this entry without an execution context, and their request.url can come
  // from the client Host header. Give Pages `res.revalidate()` an in-process
  // dispatcher there so the revalidation credential never leaves the process.
  const appRscHandler: AppRscRequestHandler = (request, ctx, ...rest) => {
    if (ctx != null || getRequestExecutionContext()) {
      return appRscRequestHandler(request, ctx, ...rest);
    }
    const executionContext = createWorkerRevalidationContext(
      undefined,
      (internalRequest, internalCtx) =>
        runWithExecutionContext(internalCtx, () =>
          appRscRequestHandler(internalRequest, internalCtx),
        ),
      "node",
    );
    return runWithExecutionContext(executionContext, () =>
      appRscRequestHandler(request, ctx, ...rest),
    );
  };
  return Object.assign(appRscHandler, {
    handleResponseStage(
      request: Request,
      ctx: unknown,
      props: AppWorkerResponseStageProps,
      stageOptions?: VinextResponseStageDispatchOptions,
    ) {
      return import("./app-rsc-response-stage.js").then(({ renderAppWorkerResponseStage }) =>
        renderAppWorkerResponseStage(options, request, ctx, props, stageOptions),
      );
    },
  });
}
