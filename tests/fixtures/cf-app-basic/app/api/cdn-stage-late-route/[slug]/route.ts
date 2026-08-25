export const revalidate = false;

export function GET(request: Request) {
  return new Response(
    new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const visitorId = request.headers.get("x-test-visitor-id") ?? "anonymous";
        const renderToken = crypto.randomUUID();
        controller.enqueue(
          new TextEncoder().encode(`late-route-visitor:${visitorId}; render-token:${renderToken}`),
        );
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/plain" } },
  );
}
