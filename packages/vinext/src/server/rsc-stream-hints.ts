const REACT_FLIGHT_STYLESHEET_PRELOAD_HINT = /(\d*:HL\[.*?),"stylesheet"(\]|,)/g;

/**
 * React Flight emits HL hints with "stylesheet" for CSS preloads, but the
 * HTML spec requires "style" for <link rel="preload">. Rewrite each complete
 * Flight line so SSR embeds, navigation, and server actions see valid hints.
 */
function normalizeReactFlightHintLine(line: string): string {
  return line.replace(REACT_FLIGHT_STYLESHEET_PRELOAD_HINT, '$1,"style"$2');
}

export function normalizeReactFlightPreloadHints(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = carry + decoder.decode(chunk, { stream: true });
        const lastNewline = text.lastIndexOf("\n");

        if (lastNewline === -1) {
          carry = text;
          return;
        }

        carry = text.slice(lastNewline + 1);
        controller.enqueue(
          encoder.encode(normalizeReactFlightHintLine(text.slice(0, lastNewline + 1))),
        );
      },
      flush(controller) {
        const text = carry + decoder.decode();
        if (text) {
          controller.enqueue(encoder.encode(normalizeReactFlightHintLine(text)));
        }
      },
    }),
  );
}
