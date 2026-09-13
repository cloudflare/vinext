// oxlint-disable-next-line typescript/triple-slash-reference -- loads virtual-module types without a runtime import
/// <reference path="../virtual-vinext-multi-stage.d.ts" />

import type { VinextRequestStageModule } from "./multi-stage.js";

/** Lazily load the router-specific request stage selected by vinext. */
export function loadVinextRequestStage<Env = unknown, Context = unknown>(): Promise<
  VinextRequestStageModule<Env, Context>
> {
  return import("virtual:vinext-request-stage");
}
