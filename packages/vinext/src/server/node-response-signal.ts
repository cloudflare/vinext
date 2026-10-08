import type { Writable } from "node:stream";

// Ported from Next.js: packages/next/src/server/web/spec-extension/adapters/next-request.ts
// https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/web/spec-extension/adapters/next-request.ts

const ResponseAbortedName = "ResponseAborted";
export class ResponseAborted extends Error {
  public readonly name = ResponseAbortedName;
}

/**
 * Creates an AbortSignal tied to the closing of a ServerResponse.
 *
 * The incoming request cannot be used: once its body has been fully read the
 * readable side is done, so a later client disconnect fires nothing on it
 * (and its `close` event also fires on normal requests). If `finish` fires
 * first, `res.end()` completed and the following `close` is our own teardown;
 * if `close` fires first, the client disconnected before we finished.
 */
export function signalFromNodeResponse(response: Writable): AbortSignal {
  const { errored, destroyed } = response;
  if (errored || destroyed) {
    return AbortSignal.abort(errored ?? new ResponseAborted());
  }

  const controller = new AbortController();
  response.once("close", () => {
    if (response.writableFinished) return;
    controller.abort(new ResponseAborted());
  });
  return controller.signal;
}
