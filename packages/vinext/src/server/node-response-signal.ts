import type { ServerResponse } from "node:http";

/** Abort work on disconnect, not when the incoming request body finishes. */
export function signalFromNodeResponse(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const cleanup = () => {
    response.off("close", onClose);
    response.off("finish", cleanup);
  };
  const onClose = () => {
    cleanup();
    if (!response.writableFinished) {
      controller.abort(
        response.errored ?? new DOMException("The client disconnected", "AbortError"),
      );
    }
  };
  if (response.destroyed || response.errored) {
    onClose();
  } else if (!response.writableFinished) {
    response.once("close", onClose);
    response.once("finish", cleanup);
  }
  return controller.signal;
}
