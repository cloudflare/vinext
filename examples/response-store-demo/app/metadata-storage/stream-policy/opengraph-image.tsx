export const revalidate = 60;
export default function Image() {
  const response = new Response(new ReadableStream({
    pull(controller) {
      response.headers.set("Cache-Control", "private, max-age=300");
      controller.enqueue(Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII="), (byte) => byte.charCodeAt(0)));
      controller.close();
    },
  }, { highWaterMark: 0 }), {
    headers: { "Cache-Control": "public, max-age=1", "Content-Type": "image/png", "X-Render-Id": crypto.randomUUID() },
  });
  return response;
}
