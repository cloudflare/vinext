import {
  isRenderDynamicLatched,
  markDynamicUsage,
  onRenderDynamicLatched,
} from "vinext/shims/internal/headers-state";
import { BailoutToCSRError } from "vinext/shims/navigation-errors";
import { createSearchParamsGate, type SearchParamsGate } from "vinext/shims/search-params-gate";
import {
  isHangingPromiseRejectionError,
  makeHangingPromise,
} from "vinext/shims/internal/make-hanging-promise";

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

/** A gate already decided `"bailout"`, for a render whose query is unknown. */
function createBailoutSearchParamsGate(): SearchParamsGate {
  const controller = createSearchParamsGate({ onOpen() {} });
  controller.settle();
  return controller.gate;
}

/**
 * The gate a Cache Components client page's SSR `searchParams` wait on. A
 * static render, such as a regeneration, has no query to give them, so they
 * bail out at once, like its `useSearchParams()`.
 */
export function resolveClientPageSearchParamsGate(
  gate: SearchParamsGate | undefined,
  isStaticGeneration: boolean,
): SearchParamsGate | undefined {
  return gate ?? (isStaticGeneration ? createBailoutSearchParamsGate() : undefined);
}

/**
 * The query and gate SSR's `useSearchParams()` reads. A resumed shell's holes
 * read the browser's query (`resumedSearch`), or bail out to the browser when a
 * Workers Cache dispatch dropped it (null); other renders read the request's.
 */
export function resolveSsrSearchParams(
  requestSearchParams: URLSearchParams,
  resumedSearch: string | null | undefined,
  candidateGate: SearchParamsGate | undefined,
): { searchParams: URLSearchParams; gate: SearchParamsGate | undefined } {
  if (resumedSearch === undefined)
    return { searchParams: requestSearchParams, gate: candidateGate };
  if (resumedSearch === null) {
    return { searchParams: new URLSearchParams(), gate: createBailoutSearchParamsGate() };
  }
  return { searchParams: new URLSearchParams(resumedSearch), gate: candidateGate };
}

type ClientPageSearchParamsHang = {
  /** The render's signal, which also aborts once a hung render settles. */
  signal: AbortSignal;
  /**
   * A client page's `searchParams` bailed out: what they hang on, which rejects
   * once the render aborts.
   */
  onHang: () => Promise<never>;
  /** Wrap the Flight stream SSR reads, to learn when it has read it all. */
  trackFlightConsumed: (flightStream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
  /**
   * The error a render error stands for: a hung `searchParams` rejecting
   * after the render aborted reports the abort, as React would without it.
   */
  reportedError: (error: unknown) => unknown;
  dispose: () => void;
};

/**
 * Like Next.js's prerender, a static render hands a client page `searchParams`
 * that never settle (`makeHangingPromise`), so the page can't catch the
 * bail-out and render something else into the stored HTML. Next.js then
 * aborts the render, and React renders every boundary still pending in the
 * browser (`createRenderInBrowserAbortSignal`). This aborts the render the
 * same way once SSR has read the whole Flight response, as nothing on the
 * server can settle the page any more.
 */
export function createClientPageSearchParamsHang(
  signal: AbortSignal | undefined,
  route: string,
): ClientPageSearchParamsHang {
  const controller = new AbortController();
  const renderSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let hung = false;
  let consumed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortIfSettled = (): void => {
    if (!hung || !consumed || timer !== undefined) return;
    // On the next task, so the render first finishes the work the payload's
    // last chunks unblocked.
    timer = setTimeout(() => controller.abort(new BailoutToCSRError("searchParams")), 0);
  };
  const markConsumed = (): void => {
    consumed = true;
    abortIfSettled();
  };
  return {
    signal: renderSignal,
    onHang() {
      hung = true;
      abortIfSettled();
      // Like Next.js's, it rejects once the render aborts. React listens to
      // the signal from the render's start, so it aborts first, and a page
      // that catches the rejection renders nothing into the response.
      return makeHangingPromise<never>(renderSignal, route, "`searchParams`");
    },
    trackFlightConsumed(flightStream) {
      const reader = flightStream.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(streamController) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (error) {
            markConsumed();
            streamController.error(error);
            return;
          }
          if (result.done) {
            streamController.close();
            markConsumed();
            return;
          }
          streamController.enqueue(result.value);
        },
        cancel(reason) {
          markConsumed();
          return reader.cancel(reason);
        },
      });
    },
    reportedError(error) {
      return renderSignal.aborted && isHangingPromiseRejectionError(error)
        ? renderSignal.reason
        : error;
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
