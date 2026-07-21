/**
 * `stream.pipeThrough(transform)` equivalent whose pump owns every promise.
 *
 * The internal pipeTo loop of `pipeThrough` can leave an in-flight
 * `writer.write` rejection unhandled when the consumer cancels the readable
 * side between chunks (observable as an unhandled rejection carrying the
 * cancel reason). This pump awaits or settles every read/write explicitly, and
 * on failure propagates the reason both ways (cancel upstream, abort the
 * transform), so cancellation reasons reach the source untouched.
 */
export function pumpThrough<I, O>(
  stream: ReadableStream<I>,
  transform: TransformStream<I, O>,
): ReadableStream<O> {
  const writer = transform.writable.getWriter();
  const reader = stream.getReader();

  // Cancelling the transform's readable errors its writable. Without this
  // watcher the pump would only notice on the next chunk, keeping a stalled
  // render's resources alive after the consumer went away.
  void writer.closed.catch((reason: unknown) => {
    void reader.cancel(reason).catch(() => {});
  });

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          await writer.close();
          return;
        }
        await writer.write(value);
      }
    } catch (error) {
      await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    }
  })();

  return transform.readable;
}
