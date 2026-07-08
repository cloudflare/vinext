import { Readable, type Readable as NodeReadable } from "node:stream";
import { text } from "node:stream/consumers";
import type { ReactNode } from "react";
import { renderToNodeFizzStream } from "./node-fizz-stream.js";

function nodeReadableToWeb(stream: NodeReadable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export async function renderPagesToReadableStream(
  element: ReactNode,
): Promise<ReadableStream<Uint8Array>> {
  return nodeReadableToWeb(await renderToNodeFizzStream(element));
}

export async function renderPagesToString(element: ReactNode): Promise<string> {
  return text(await renderToNodeFizzStream(element, {}, { waitForAllReady: true }));
}
