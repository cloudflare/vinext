// Records whether a request's AbortSignal fired, so client-disconnect tests
// (tests/node-request-cancellation.test.ts) can observe it through a status
// request. Modelled on Next.js: test/e2e/cancel-request/
// https://github.com/vercel/next.js/tree/v16.2.6/test/e2e/cancel-request

type RequestSignalProbe = {
  aborted: boolean;
  reason: string | null;
  /** Whether the response body stream was cancelled. */
  cancelled: boolean;
  /** Whether a middleware request-header override reached the handler. */
  overridden: boolean;
  /** Whether `?mode=hang` gave up waiting instead of observing the abort. */
  timedOut: boolean;
  /** Whether a POST body is still being read. */
  uploading: boolean;
  /** Whether the signal aborted while the POST body was still being read. */
  abortedWhileUploading: boolean;
};

export const REQUEST_SIGNAL_OVERRIDE_HEADER = "x-request-signal-override";

const PROBES_KEY = Symbol.for("vinext.test.requestSignalProbes");

function probes(): Map<string, RequestSignalProbe> {
  const existing: unknown = Reflect.get(globalThis, PROBES_KEY);
  if (existing instanceof Map) return existing;
  const created = new Map<string, RequestSignalProbe>();
  Reflect.set(globalThis, PROBES_KEY, created);
  return created;
}

function reasonName(reason: unknown): string | null {
  if (!reason || typeof reason !== "object") return null;
  const name: unknown = Reflect.get(reason, "name");
  return typeof name === "string" ? name : null;
}

/** One event, then stays open until the server cancels the body. */
function streamedResponse(probe: RequestSignalProbe): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: start\n\n"));
      },
      cancel() {
        probe.cancelled = true;
      },
    }),
    { headers: { "cache-control": "no-store", "content-type": "text/event-stream" } },
  );
}

/**
 * `?mode=status&id=<id>` reports the probe recorded for `<id>`.
 * `?mode=hang` holds the response until the request signal aborts, then
 *   returns a streamed body the server should cancel.
 * `?mode=stream` streams one event and then stays open.
 * Any other mode responds immediately.
 * `?override` asks the fixture middleware to override a request header first.
 */
export async function handleRequestSignalProbe(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const mode = url.searchParams.get("mode");
  if (mode === "status") {
    return Response.json(probes().get(id) ?? null, {
      headers: { "cache-control": "no-store" },
    });
  }

  const { signal } = request;
  const probe: RequestSignalProbe = {
    aborted: false,
    reason: null,
    cancelled: false,
    overridden: request.headers.get(REQUEST_SIGNAL_OVERRIDE_HEADER) === "1",
    timedOut: false,
    uploading: false,
    abortedWhileUploading: false,
  };
  probes().set(id, probe);
  const aborted = new Promise<void>((resolve) => {
    const onAbort = () => {
      probe.aborted = true;
      probe.reason = reasonName(signal.reason);
      probe.abortedWhileUploading = probe.uploading;
      resolve();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });

  // Read any body after registering, so a disconnect mid-upload is recorded
  // and a finished body read cannot be mistaken for a client disconnect.
  if (request.method === "POST") {
    probe.uploading = true;
    try {
      await request.text();
    } catch {
      // An interrupted upload rejects the read.
    } finally {
      probe.uploading = false;
    }
  }

  if (mode === "hang") {
    // Give up eventually so a missing abort fails the test instead of leaving
    // the request pending forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      aborted,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    clearTimeout(timer);
    if (!signal.aborted) {
      probe.timedOut = true;
      return new Response("done", { headers: { "cache-control": "no-store" } });
    }
    // Produced after the disconnect, so the server must discard (cancel) it.
    return streamedResponse(probe);
  }

  if (mode === "stream") return streamedResponse(probe);

  return new Response("ok", { headers: { "cache-control": "no-store" } });
}
