/** Combined request/response handler used by default single-stage App entries. */

import {
  createAppRscRequestHandler,
  type AppRscHandlerRoute,
  type AppRscRequestHandler,
  type CreateAppRscHandlerOptions,
} from "./app-rsc-handler.js";
import type { AppWorkerResponseStageProps } from "./app-worker-stages.js";
import type { VinextResponseStageDispatchOptions } from "./multi-stage.js";

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
  const appRscHandler = createAppRscRequestHandler(options);
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
