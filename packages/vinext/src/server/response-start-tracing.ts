import { preserveFullyBufferedBodyMetadata } from "./fully-buffered-response.js";
import { copyLinkHeaderProvenance } from "./app-response-header-provenance.js";
import { frameworkTracer } from "./tracer.js";

const tracedResponses = new WeakMap<Response, Promise<void>>();

export function getResponseStartCompletion(response: Response): Promise<void> | undefined {
  return tracedResponses.get(response);
}

export function createResponseStartSpanDescriptor() {
  return {
    name: "start response",
    type: "NextNodeServer.startResponse",
  } as const;
}

function traceResponseStartStream(
  stream: ReadableStream<Uint8Array>,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const runInTraceContext = frameworkTracer.captureActiveContext();
  let started = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            onSettled();
            controller.close();
            return;
          }
          if (!started) {
            started = true;
            runInTraceContext(() =>
              frameworkTracer.trace(createResponseStartSpanDescriptor(), () => undefined),
            );
            onSettled();
          }
          controller.enqueue(result.value);
        } catch (error) {
          onSettled();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          onSettled();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

export function traceResponseStartWithCompletion(response: Response): {
  response: Response;
  started: Promise<void>;
} {
  const existing = tracedResponses.get(response);
  if (existing) return { response, started: existing };
  // The stream wrapper exists only to time the start span, so skip it when no
  // backend would record that span.
  if (!response.body || !frameworkTracer.isRecording()) {
    return { response, started: Promise.resolve() };
  }

  let onSettled!: () => void;
  const started = new Promise<void>((resolve) => {
    onSettled = resolve;
  });

  const traced = preserveFullyBufferedBodyMetadata(
    response,
    new Response(traceResponseStartStream(response.body, onSettled), response as ResponseInit),
  );
  copyLinkHeaderProvenance(response.headers, traced.headers);
  tracedResponses.set(traced, started);
  return { response: traced, started };
}

export function traceResponseStart(response: Response): Response {
  return traceResponseStartWithCompletion(response).response;
}

/**
 * Trace a response replayed by a cache above the framework renderer.
 *
 * A replayed body is a stored, complete response rather than a render in
 * progress, so the zero-duration start span is recorded as the replay is handed
 * back instead of re-streaming the whole body through a JS reader just to
 * observe its first chunk.
 */
export function traceCachedResponseStart(
  response: Response,
  cacheStatus: string | null,
  responseStageProps: unknown,
): Response {
  const props =
    responseStageProps && typeof responseStageProps === "object" ? responseStageProps : null;
  const kind = props ? Reflect.get(props, "kind") : undefined;
  const isTracedResponse =
    kind === "app-route-handler" ||
    (kind === "app-page" && props !== null && Reflect.get(props, "isRscRequest") === false);
  if (
    isTracedResponse &&
    (cacheStatus === "HIT" ||
      cacheStatus === "STALE" ||
      cacheStatus === "REVALIDATED" ||
      cacheStatus === "UPDATING") &&
    response.body &&
    frameworkTracer.isRecording()
  ) {
    frameworkTracer.trace(createResponseStartSpanDescriptor(), () => undefined);
  }
  return response;
}
