import { pipeline, Transform, type Readable as NodeReadable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  createAppHtmlInsertionState,
  type CreateAppHtmlInsertionStateOptions,
} from "./app-ssr-stream.js";

function enqueueStrings(stream: Transform, chunks: string[]): void {
  for (const chunk of chunks) {
    stream.push(Buffer.from(chunk));
  }
}

export function createNodeTickBufferedTransform(
  options: CreateAppHtmlInsertionStateOptions,
): Transform {
  const decoder = new StringDecoder("utf8");
  const state = createAppHtmlInsertionState(options);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      state.push(decoder.write(chunk));

      if (timeoutId === null) {
        timeoutId = setTimeout(() => {
          try {
            enqueueStrings(stream, state.flushTick());
          } catch {
            // The stream may have been destroyed between scheduling and the
            // tick flush. The Web adapter has the same cancellation tolerance.
          }
          timeoutId = null;
        }, 0);
      }

      callback();
    },

    async flush(callback) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      const remainder = decoder.end();
      if (remainder) {
        state.push(remainder);
      }

      try {
        enqueueStrings(stream, await state.finish());
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  return stream;
}

export function pipeWithCancellationPropagation(
  source: NodeReadable,
  transform: Transform,
): NodeReadable {
  return pipeline(source, transform, () => {});
}
