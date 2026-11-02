// Served by the Worker entry before vinext, so a client disconnect reaches the
// response stream directly. Coverage: tests/e2e/cloudflare-workers/streams-lab.spec.ts

// Only meaningful when one isolate serves both requests, as under wrangler dev.
const cancelled = new Set<string>();

export function handleStreamsLabDisconnect(url: URL): Response | null {
  const token = url.searchParams.get("token") ?? "none";
  if (url.pathname === "/__streams-lab/disconnect") {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.enqueue(encoder.encode("tick\n"));
        },
        cancel() {
          cancelled.add(token);
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  }
  if (url.pathname === "/__streams-lab/disconnect-status") {
    return Response.json({ cancelled: cancelled.has(token) });
  }
  return null;
}
