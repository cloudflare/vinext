export const revalidate = 60;

export function GET(request: Request) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(encoder.encode(request.headers.get("x-tenant") ?? "missing"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    {
      headers: {
        "Cache-Control": "public, s-maxage=60",
        "Content-Type": "text/plain",
      },
    },
  );
}
