export const revalidate = 60;
export function GET() {
  const renderId = crypto.randomUUID();
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          response.headers.set("Cache-Control", "private, max-age=300");
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ renderId })));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    {
      headers: { "Cache-Control": "public, max-age=1", "Content-Type": "application/json" },
    },
  );
  return response;
}
