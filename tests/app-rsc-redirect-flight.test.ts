import { describe, expect, it } from "vite-plus/test";
import type { ReactNode } from "react";
import ReactDOMServer from "react-dom/server";
import {
  buildRscRedirectFlightStream,
  formatNextRedirectDigest,
} from "../packages/vinext/src/server/app-rsc-redirect-flight.js";

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

describe("app RSC redirect flight encoding", () => {
  it("formats the canonical NEXT_REDIRECT digest with a replace-style default", () => {
    // Next.js's getRedirectError writes `${CODE};${type};${url};${status};`
    // with the raw URL and a replace default outside server actions.
    expect(formatNextRedirectDigest({ type: "replace", url: "/about", statusCode: 307 })).toBe(
      "NEXT_REDIRECT;replace;/about;307;",
    );
    expect(
      formatNextRedirectDigest({ type: "push", url: "https://example.com/x", statusCode: 308 }),
    ).toBe("NEXT_REDIRECT;push;https://example.com/x;308;");
  });

  it("renders an element that throws the digest and reports it through onError", async () => {
    const digest = formatNextRedirectDigest({ type: "replace", url: "/login", statusCode: 307 });
    let thrown: unknown;
    let reportedDigest: unknown;

    // Stand in for react-server-dom's renderToReadableStream: driving the
    // element through React triggers the synchronous throw, and onError maps
    // the error to the digest that gets serialized into the flight stream.
    const renderToReadableStream = (
      element: ReactNode,
      options: {
        onError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown;
      },
    ): ReadableStream<Uint8Array> => {
      try {
        ReactDOMServer.renderToStaticMarkup(element);
      } catch (error) {
        thrown = error;
        reportedDigest = options.onError(error, undefined, undefined);
      }
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(String(reportedDigest)));
          controller.close();
        },
      });
    };

    const stream = buildRscRedirectFlightStream({ renderToReadableStream, digest });

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { digest?: unknown }).digest).toBe(digest);
    expect(reportedDigest).toBe(digest);
    expect(await readStream(stream)).toBe(digest);
  });
});
