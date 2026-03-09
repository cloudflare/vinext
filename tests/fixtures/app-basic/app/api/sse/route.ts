/**
 * Server-Sent Events streaming API route.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/open-next/app/sse/
 * Tests: ON-5 in TRACKING.md
 *
 * Sends 4 messages with 1-second delays between them to verify streaming
 * is working correctly (messages arrive incrementally, not buffered).
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Initial open message
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ message: "open" })}\n\n`));

      // Send 3 messages with 1-second delays
      for (let i = 1; i <= 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ message: `hello:${i}` })}\n\n`),
        );
      }

      // Close message
      await new Promise((resolve) => setTimeout(resolve, 1000));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ message: "close" })}\n\n`));

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
