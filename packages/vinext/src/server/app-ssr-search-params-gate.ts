import {
  isRenderDynamicLatched,
  markDynamicUsage,
  onRenderDynamicLatched,
} from "vinext/shims/headers";
import { createSearchParamsGate, type SearchParamsGate } from "vinext/shims/search-params-gate";

type CandidateSearchParamsGate = {
  gate: SearchParamsGate;
  /**
   * Wrap the Flight stream SSR reads. The gate settles once SSR has read it to
   * the end, or it is cancelled or fails.
   */
  settleWhenConsumed: (flightStream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
};

/**
 * Start the SSR `useSearchParams()` gate of a cache-candidate render.
 *
 * The gate opens with real values as soon as the render uses a dynamic API,
 * including before this call. Otherwise it bails out when the render settles:
 * the RSC stream has ended and SSR has read the whole Flight response, so no
 * server component can mark the render dynamic any more.
 */
export function startCandidateSearchParamsGate(): CandidateSearchParamsGate {
  const controller = createSearchParamsGate({ onOpen: markDynamicUsage });
  const unsubscribe = onRenderDynamicLatched(() => controller.open());
  if (isRenderDynamicLatched()) controller.open();

  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    controller.settle();
  };

  return {
    gate: controller.gate,
    settleWhenConsumed: (flightStream) => {
      const reader = flightStream.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(streamController) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (error) {
            settle();
            streamController.error(error);
            return;
          }
          if (result.done) {
            streamController.close();
            settle();
            return;
          }
          streamController.enqueue(result.value);
        },
        cancel(reason) {
          settle();
          return reader.cancel(reason);
        },
      });
    },
  };
}
