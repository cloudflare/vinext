import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { readStreamAsText } from "../utils/text-stream.js";

export async function renderPagesToReadableStream(
  element: ReactNode,
): Promise<ReadableStream<Uint8Array>> {
  return renderToReadableStream(element);
}

export async function renderPagesToString(element: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return readStreamAsText(stream);
}
