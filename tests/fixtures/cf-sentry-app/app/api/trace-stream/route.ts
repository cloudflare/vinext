import * as Sentry from "@sentry/nextjs";

export function GET() {
  let sent = false;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (sent) return;
        sent = true;
        await Sentry.startSpan(
          { name: "fixture.app.stream.child", op: "fixture.stream" },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            controller.enqueue(new TextEncoder().encode("streamed"));
            controller.close();
          },
        );
      },
    }),
  );
}
