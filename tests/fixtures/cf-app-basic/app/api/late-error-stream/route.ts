export const revalidate = 60;

export function GET() {
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(new Error("late route body failure"));
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "Content-Type": "text/plain" } },
  );
}
