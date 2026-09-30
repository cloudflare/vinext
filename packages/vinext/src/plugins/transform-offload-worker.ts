/**
 * Worker thread entry for `transform-offload.ts`. Runs the registered pure
 * transforms on request; a transform that throws is reported as an error so
 * the main thread re-runs it in-process and surfaces the original exception.
 */
import { parentPort } from "node:worker_threads";
import { transformVeryDynamicRequests } from "./ignore-dynamic-requests.js";
import { rewriteModuleIdentity } from "./import-meta-url.js";
import { replaceConsumerEnvironmentConditions } from "./typeof-window.js";
import type { PureTransformRequest, PureTransformResponse } from "./transform-offload.js";
import type { MagicStringTransformResult } from "./transform-result.js";

const pureTransforms = {
  "ignore-dynamic-requests": transformVeryDynamicRequests,
  "import-meta-url": rewriteModuleIdentity,
  "typeof-window": replaceConsumerEnvironmentConditions,
};

export type PureTransforms = typeof pureTransforms;
export type PureTransformKind = keyof PureTransforms;

const port = parentPort;

port?.on("message", ({ id, kind, args, sourcemap }: PureTransformRequest) => {
  let response: PureTransformResponse;
  try {
    const transform = pureTransforms[kind] as (
      ...args: unknown[]
    ) => MagicStringTransformResult | null;
    const result = transform(...args);
    response = {
      id,
      result: result && { code: result.code, map: sourcemap ? result.map : undefined },
    };
  } catch {
    response = { id, error: true };
  }
  port.postMessage(response);
});
