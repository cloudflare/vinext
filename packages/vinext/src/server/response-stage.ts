// oxlint-disable-next-line typescript/triple-slash-reference -- loads virtual-module types without a runtime import
/// <reference path="../virtual-vinext-multi-stage.d.ts" />

import type { VinextResponseStageModule } from "./multi-stage.js";

/** Lazily load the router-specific response stage selected by vinext. */
export function loadVinextResponseStage<Env = unknown, Context = unknown>(): Promise<
  VinextResponseStageModule<Env, Context>
> {
  return import("virtual:vinext-response-stage");
}
