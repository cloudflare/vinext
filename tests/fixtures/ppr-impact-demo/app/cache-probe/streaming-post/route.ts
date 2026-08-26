const encoder = new TextEncoder();

export function POST() {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("streaming "));
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.enqueue(encoder.encode("post"));
        controller.close();
      },
    }),
  );
}
