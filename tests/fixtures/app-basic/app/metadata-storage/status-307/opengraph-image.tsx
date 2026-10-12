export const revalidate = 2;
export default function Image() {
  return new Response("metadata status 307", {
    status: 307,
    headers: {
      "Cache-Control": "private, max-age=300",
      "X-Render-Id": crypto.randomUUID(),
    },
  });
}
