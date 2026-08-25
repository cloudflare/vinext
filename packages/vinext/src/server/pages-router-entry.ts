/** Router-specific single-entry Worker facade for vinext Pages Router. */

import {
  handleRequestStageLocally,
  type PagesWorkerEnv,
  type PagesWorkerExecutionContext,
} from "./pages-request-stage-entry.js";
import { renderPagesResponse } from "./pages-response-stage-entry.js";

export default {
  fetch(
    request: Request,
    env?: PagesWorkerEnv,
    ctx?: PagesWorkerExecutionContext,
  ): Promise<Response> {
    return handleRequestStageLocally(request, env, ctx, (stageRequest, stageEnv, stageCtx, props) =>
      renderPagesResponse(stageRequest, stageEnv, stageCtx, props),
    );
  },
};
