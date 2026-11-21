import {
  createRenderStreamCancellation,
  type RenderStreamCancellation,
} from "./app-render-abort-error.js";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";

export type RscRawRenderer = (model: unknown, options?: unknown) => ReadableStream<Uint8Array>;

const noop = (): void => {};

export function createRscRenderer(render: RscRawRenderer): RscRawRenderer {
  return (model, options) => {
    const cancellation = createRenderStreamCancellation();
    // Records the reason before the cancellation reaches React, so the
    // render's onError can tell it apart from a render failure.
    return deferUntilStreamConsumed(
      render(model, ignoreCancellationErrors(options, cancellation)),
      noop,
      undefined,
      cancellation.record,
    );
  };
}

/** A consumer cancelling the payload is not a render failure. */
function ignoreCancellationErrors(
  options: unknown,
  cancellation: RenderStreamCancellation,
): unknown {
  if (!options || typeof options !== "object") return options;
  const onError: unknown = Reflect.get(options, "onError");
  if (typeof onError !== "function") return options;
  return {
    ...options,
    onError(error: unknown, ...rest: unknown[]) {
      if (cancellation.isReason(error)) return undefined;
      return Reflect.apply(onError, options, [error, ...rest]);
    },
  };
}
