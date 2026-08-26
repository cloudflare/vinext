export const revalidate = 300;

export function GET() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: cache-probe-ready\n\n"));
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
