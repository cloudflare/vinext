import type { ExecutionContextLike } from "vinext/shims/request-context";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { applyCdnResponseHeaders, NO_STORE_CACHE_CONTROL } from "./cache-control.js";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";
import type { CacheabilityRouteState } from "./cacheability-manifest.js";
import {
  CACHEABILITY_RESPONSE_BODY_LIMIT,
  CACHEABILITY_RESPONSE_CAPTURE_BUDGET,
  CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
} from "./cacheability-limits.js";
import {
  acquireCacheabilityCaptureReader,
  captureCapacityUnavailableResponse,
  createCacheabilityCaptureReservation,
  explicitCachePolicyOutcome,
  frameworkNow,
  isUpgradeResponse,
  readCacheabilityState,
  reportStaticToDynamicError,
  responseCachePolicy,
  responseHasFinalCacheOptOut,
  responseHasUnsupportedVary,
  responsePolicyIsCacheable,
  syntheticErrorResponse,
  uncacheableStreamingResponse,
  type CacheabilityCaptureOptions,
  type CacheabilityOutcome,
  type CacheabilityRequestState,
  type CapturedResponseBody,
} from "./cacheability-request.js";

function streamCapturedPrefixThenReader(
  prefix: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  releasePrefix: () => void,
  sourceOwnedOverflow?: Uint8Array,
): ReadableStream<Uint8Array> {
  let index = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releasePrefix();
  };
  return new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        prefix.length = 0;
        sourceOwnedOverflow = undefined;
        release();
        await reader.cancel(reason).catch(() => {});
      },
      async pull(controller) {
        try {
          if (index < prefix.length) {
            controller.enqueue(prefix[index++]);
            if (index === prefix.length) {
              prefix.length = 0;
              if (!sourceOwnedOverflow) release();
            }
            return;
          }
          if (sourceOwnedOverflow) {
            const chunk = sourceOwnedOverflow;
            sourceOwnedOverflow = undefined;
            controller.enqueue(chunk);
            release();
            return;
          }
          release();
          const result = await reader.read();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Collect a response body only while it remains within the Worker-safe size
 * and time bounds. This module is loaded only when CDN classification needs it.
 */
export async function captureResponseBodyBoundedRuntime(
  response: Response,
  options: CacheabilityCaptureOptions = {},
): Promise<CapturedResponseBody> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error("response capture was aborted");
  }
  if (!response.body) {
    return { body: null, fallback: null, failClosed: false, release: () => {} };
  }

  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > CACHEABILITY_RESPONSE_BODY_LIMIT) {
    return {
      failure: "oversize",
      failClosed: true,
      fallback: response.body,
      reason: `response body exceeded ${CACHEABILITY_RESPONSE_BODY_LIMIT} bytes`,
    };
  }

  const captureStartedAt = frameworkNow();
  const requestDeadlineAt = readCacheabilityState(getRequestExecutionContext())?.captureDeadlineAt;
  const captureDeadlineAt = Math.min(
    captureStartedAt + CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
    requestDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  const remainingCaptureMs = (): number => Math.max(0, captureDeadlineAt - frameworkNow());
  const waitForCapacity =
    options.waitForCapacity ??
    (() => {
      const mode = readCacheabilityState(getRequestExecutionContext())?.mode;
      return mode === "probe" || mode === "warm";
    })();
  const releaseReader = await acquireCacheabilityCaptureReader(
    options.signal,
    waitForCapacity ? remainingCaptureMs() : 0,
  );
  if (!releaseReader) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("response capture was aborted");
    }
    return {
      failure: "capacity",
      failClosed: true,
      fallback: response.body,
      reason: waitForCapacity
        ? "response capture did not acquire isolate capacity before the classification deadline"
        : "response capture isolate capacity is currently unavailable",
    };
  }
  try {
    options.onCaptureStart?.();
  } catch (error) {
    releaseReader();
    throw error;
  }

  const reservation = createCacheabilityCaptureReservation();
  let captureStream: ReadableStream<Uint8Array>;
  let fallback: ReadableStream<Uint8Array>;
  try {
    [captureStream, fallback] = response.body.tee();
  } catch (error) {
    releaseReader();
    reservation.releaseAll();
    throw error;
  }
  const reader = captureStream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let retainedChunkBytes = 0;
  let overflowChunk: Uint8Array | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  try {
    const readResult = await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return "complete" as const;
          length += value.byteLength;
          if (length > CACHEABILITY_RESPONSE_BODY_LIMIT) {
            overflowChunk = value;
            return "oversized" as const;
          }
          if (!reservation.tryReserve(value.byteLength * 2)) {
            overflowChunk = value;
            return "budget-exhausted" as const;
          }
          retainedChunkBytes += value.byteLength;
          chunks.push(value);
        }
      })(),
      new Promise<"timed-out">((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), remainingCaptureMs());
      }),
      new Promise<"aborted">((resolve) => {
        const signal = options.signal;
        if (!signal) return;
        const onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }),
    ]);
    if (readResult === "aborted") {
      await Promise.allSettled([reader.cancel(options.signal?.reason), fallback.cancel()]);
      releaseReader();
      reservation.releaseAll();
      throw options.signal?.reason ?? new Error("response capture was aborted");
    }
    if (readResult !== "complete") {
      if (readResult !== "timed-out") {
        void fallback.cancel().catch(() => {});
        reservation.release(retainedChunkBytes);
        return {
          failure: readResult === "budget-exhausted" ? "budget" : "oversize",
          failClosed: true,
          fallback: streamCapturedPrefixThenReader(
            chunks,
            reader,
            () => {
              reservation.releaseAll();
              releaseReader();
            },
            overflowChunk,
          ),
          reason:
            readResult === "budget-exhausted"
              ? `response capture exceeded the ${CACHEABILITY_RESPONSE_CAPTURE_BUDGET} byte isolate budget`
              : `response body exceeded ${CACHEABILITY_RESPONSE_BODY_LIMIT} bytes`,
        };
      }
      void reader.cancel().catch(() => {});
      releaseReader();
      reservation.release(retainedChunkBytes);
      return {
        failure: "timeout",
        failClosed: true,
        fallback: deferUntilStreamConsumed(fallback, reservation.releaseAll),
        reason: `response body did not complete within ${CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS}ms`,
      };
    }
    releaseReader();
  } catch (error) {
    releaseReader();
    void fallback.cancel().catch(() => {});
    reservation.releaseAll();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener?.();
  }

  try {
    if (!reservation.tryReserve(length)) {
      void fallback.cancel().catch(() => {});
      reservation.release(retainedChunkBytes);
      return {
        failure: "budget",
        failClosed: true,
        fallback: streamCapturedPrefixThenReader(chunks, reader, reservation.releaseAll),
        reason: `response capture exceeded the ${CACHEABILITY_RESPONSE_CAPTURE_BUDGET} byte isolate budget`,
      };
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    reservation.release(retainedChunkBytes);
    return {
      body: body.buffer,
      fallback: deferUntilStreamConsumed(fallback, () => reservation.release(length)),
      failClosed: false,
      release: () => reservation.release(length),
    };
  } catch (error) {
    reservation.releaseAll();
    void fallback.cancel().catch(() => {});
    throw error;
  }
}

function probeResponse(
  state: CacheabilityRequestState,
  routeState: CacheabilityRouteState,
  outcome: CacheabilityOutcome,
  status: number,
): Response {
  const body = {
    cacheControl: outcome.cacheControl,
    ...(state.explicitCachePolicy && state.outcome?.dynamicUsage === true
      ? { explicitPolicyDynamicOverride: true }
      : {}),
    kind: state.route?.kind,
    pattern: state.route?.pattern,
    reason: outcome.reason,
    state: routeState,
    status,
    version: 1,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "Cache-Control": NO_STORE_CACHE_CONTROL,
      "Content-Type": "application/json",
    },
    status: 200,
  });
}

export async function finalizeWorkerCacheabilityResponseRuntime(
  response: Response,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const state = readCacheabilityState(ctx);
  if (!state) return response;
  try {
    return await finalizeWorkerCacheabilityResponseWithState(response, state);
  } finally {
    state.closed = true;
    state.capturedBodyRelease?.();
    state.capturedBodyRelease = undefined;
    for (const release of state.releaseCapturedBodies ?? []) release();
    state.releaseCapturedBodies = undefined;
  }
}

async function finalizeWorkerCacheabilityResponseWithState(
  response: Response,
  state: CacheabilityRequestState,
): Promise<Response> {
  if (state.mode === "identity") {
    void response.body?.cancel().catch(() => {});
    return probeResponse(
      state,
      state.route ? "runtime-check" : "probe-failed",
      {
        cacheable: false,
        ...(state.route ? {} : { reason: "request did not resolve to a probeable route" }),
      },
      response.status,
    );
  }
  if (!state.route) {
    if (state.mode === "probe") {
      return probeResponse(
        state,
        "probe-failed",
        { cacheable: false, reason: "request did not resolve to a probeable route" },
        response.status,
      );
    }
    return state.unsafeReason && !isUpgradeResponse(response)
      ? uncacheableStreamingResponse(response)
      : response;
  }

  if (isUpgradeResponse(response)) {
    if (state.mode !== "probe") return response;
    return probeResponse(
      state,
      "dynamic",
      { cacheable: false, reason: "upgrade response" },
      response.status,
    );
  }

  if (state.mode === "probe" && response.status >= 500) {
    void response.body?.cancel().catch(() => {});
    return probeResponse(
      state,
      "probe-failed",
      { cacheable: false, reason: `route returned HTTP ${response.status}` },
      response.status,
    );
  }

  const authoritativePolicyOutcome = explicitCachePolicyOutcome(response, state);
  const staticCandidateBecameDynamic = (outcome: CacheabilityOutcome | undefined): boolean =>
    state.mode !== "probe" &&
    !(
      state.manifestRoute?.explicitPolicyDynamicOverride === true &&
      authoritativePolicyOutcome !== undefined
    ) &&
    state.manifestRoute?.state === "static-candidate" &&
    state.route?.partialPrerender !== true &&
    outcome?.dynamicUsage === true;
  const staticToDynamicErrorResponse = async (outcome: CacheabilityOutcome): Promise<Response> => {
    await reportStaticToDynamicError(state, outcome);
    return syntheticErrorResponse(response);
  };

  const explicitOutcome = state.manifestOutcome ?? state.outcome;
  if (staticCandidateBecameDynamic(explicitOutcome)) {
    void response.body?.cancel().catch(() => {});
    return staticToDynamicErrorResponse(explicitOutcome!);
  }
  if (state.mode === "warm" && explicitOutcome?.classificationFailure === true) {
    void response.body?.cancel().catch(() => {});
    return captureCapacityUnavailableResponse();
  }

  const isEventStream = response.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("text/event-stream");
  const unsupportedVary = responseHasUnsupportedVary(response);
  if (
    isEventStream ||
    unsupportedVary ||
    (authoritativePolicyOutcome === undefined && explicitOutcome?.cacheable === false) ||
    responseHasFinalCacheOptOut(response, state) ||
    (!state.completion && !responsePolicyIsCacheable(response))
  ) {
    if (state.mode === "probe") {
      void response.body?.cancel().catch(() => {});
      return probeResponse(
        state,
        explicitOutcome?.classificationFailure === true ? "probe-failed" : "dynamic",
        explicitOutcome ?? {
          cacheable: false,
          reason: isEventStream
            ? "event stream"
            : unsupportedVary
              ? "response varies by an unsupported request header"
              : undefined,
        },
        response.status,
      );
    }
    return uncacheableStreamingResponse(response);
  }

  const deferredOutcome = state.completion ? await state.completion : undefined;
  const classificationFailureOutcome =
    state.manifestOutcome?.classificationFailure === true
      ? state.manifestOutcome
      : deferredOutcome?.classificationFailure === true
        ? deferredOutcome
        : state.outcome?.classificationFailure === true
          ? state.outcome
          : undefined;
  const completedOutcome =
    classificationFailureOutcome ??
    authoritativePolicyOutcome ??
    state.manifestOutcome ??
    deferredOutcome ??
    state.outcome;
  if (state.mode === "warm" && completedOutcome?.classificationFailure === true) {
    void response.body?.cancel().catch(() => {});
    return captureCapacityUnavailableResponse();
  }
  if (staticCandidateBecameDynamic(completedOutcome)) {
    void response.body?.cancel().catch(() => {});
    return staticToDynamicErrorResponse(completedOutcome!);
  }
  if (completedOutcome?.cacheable === false) {
    if (state.mode === "probe") {
      void response.body?.cancel().catch(() => {});
      return probeResponse(
        state,
        completedOutcome.classificationFailure === true ? "probe-failed" : "dynamic",
        completedOutcome,
        response.status,
      );
    }
    return uncacheableStreamingResponse(response);
  }

  let captured: CapturedResponseBody;
  if (state.capturedBody !== undefined) {
    const release = state.capturedBodyRelease ?? (() => {});
    const body = state.capturedBody;
    state.capturedBody = undefined;
    state.capturedBodyRelease = undefined;
    captured = { body, fallback: null, failClosed: false, release };
  } else {
    try {
      captured = await captureResponseBodyBoundedRuntime(response);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (state.mode === "probe") {
        return probeResponse(state, "probe-failed", { cacheable: false, reason }, response.status);
      }
      return syntheticErrorResponse(response);
    }
  }

  let releaseCaptured = captured.failClosed ? null : captured.release;
  try {
    if (captured.failClosed) {
      if (state.mode === "probe") {
        void captured.fallback.cancel().catch(() => {});
        return probeResponse(
          state,
          "probe-failed",
          { cacheable: false, reason: captured.reason },
          response.status,
        );
      }
      if (state.mode === "warm") {
        void captured.fallback.cancel().catch(() => {});
        return captureCapacityUnavailableResponse();
      }
      return uncacheableStreamingResponse(
        new Response(captured.fallback, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        }),
      );
    }

    const outcome =
      completedOutcome ??
      ({
        cacheable: responsePolicyIsCacheable(response),
        cacheControl: responseCachePolicy(response),
      } satisfies CacheabilityOutcome);
    const cacheable =
      !state.unsafeReason && outcome.cacheable && !responseHasFinalCacheOptOut(response, state);

    if (state.mode === "warm" && outcome.classificationFailure === true) {
      await captured.fallback?.cancel().catch(() => {});
      return captureCapacityUnavailableResponse();
    }
    if (state.mode === "probe") {
      await captured.fallback?.cancel().catch(() => {});
      return probeResponse(
        state,
        cacheable
          ? "static-candidate"
          : outcome.classificationFailure === true
            ? "probe-failed"
            : "dynamic",
        outcome,
        response.status,
      );
    }
    if (staticCandidateBecameDynamic(outcome)) {
      await captured.fallback?.cancel().catch(() => {});
      return staticToDynamicErrorResponse(outcome);
    }

    await captured.fallback?.cancel().catch(() => {});
    const headers = new Headers(response.headers);
    if (cacheable && outcome.cacheControl) {
      applyCdnResponseHeaders(headers, {
        cacheControl: outcome.cacheControl,
        tags: outcome.tags,
      });
    } else {
      applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
    }
    const capturedResponse = new Response(captured.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
    if (!releaseCaptured || !capturedResponse.body) {
      releaseCaptured?.();
      releaseCaptured = null;
      return capturedResponse;
    }
    const releaseWhenConsumed = releaseCaptured;
    releaseCaptured = null;
    return new Response(deferUntilStreamConsumed(capturedResponse.body, releaseWhenConsumed), {
      headers: capturedResponse.headers,
      status: capturedResponse.status,
      statusText: capturedResponse.statusText,
    });
  } finally {
    releaseCaptured?.();
  }
}
