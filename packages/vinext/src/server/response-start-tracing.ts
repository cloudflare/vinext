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
  if (!response.body) return { response, started: Promise.resolve() };

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

/** Trace a response replayed by a cache above the framework renderer. */
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
  return isTracedResponse &&
    (cacheStatus === "HIT" ||
      cacheStatus === "STALE" ||
      cacheStatus === "REVALIDATED" ||
      cacheStatus === "UPDATING")
    ? traceResponseStart(response)
    : response;
}
