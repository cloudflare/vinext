import { after } from "next/server";

// Module-level state for testing deferred after() timing/ordering, mirroring
// api/after-test's pattern.
let ran = false;

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("check") === "1") {
    return Response.json({ ran });
  }
  if (url.searchParams.get("reset") === "1") {
    ran = false;
    return Response.json({ resetDone: true });
  }

  // GET() returns immediately with a Response wrapping a ReadableStream
  // whose producer — including its after() call — keeps running afterward.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      after(() => {
        ran = true;
      });
      controller.enqueue(encoder.encode("hello-stream"));
      controller.close();
    },
  });

  return new Response(stream);
}
