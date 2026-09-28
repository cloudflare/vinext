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
   * the end, and opens if it is cancelled or fails.
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

  let finished = false;
  const finish = (endedNormally: boolean): void => {
    if (finished) return;
    finished = true;
    unsubscribe();
    // Only a normal end proves no server component can still mark the render
    // dynamic. A failed or cancelled stream opens the gate instead, so the
    // render is never stored and its real failure isn't replaced by a bailout.
    if (endedNormally) controller.settle();
    else controller.open();
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
            finish(false);
            streamController.error(error);
            return;
          }
          if (result.done) {
            streamController.close();
            finish(true);
            return;
          }
          streamController.enqueue(result.value);
        },
        cancel(reason) {
          finish(false);
          return reader.cancel(reason);
        },
      });
    },
  };
}
