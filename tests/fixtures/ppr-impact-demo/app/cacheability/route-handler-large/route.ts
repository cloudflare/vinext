export const revalidate = 60;

const BODY_SIZE = 4 * 1024 * 1024 + 1;

export function GET() {
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(BODY_SIZE).fill(97));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "Content-Type": "application/octet-stream" } },
  );
}
