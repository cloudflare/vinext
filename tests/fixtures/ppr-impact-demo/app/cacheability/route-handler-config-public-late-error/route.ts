import { headers } from "next/headers";

export async function GET() {
  await headers();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        queueMicrotask(() => controller.error(new Error("late route handler failure")));
      },
    }),
  );
}
