export default function Image() {
  return new Response("metadata-image", {
    headers: {
      "Cache-Control": "public, immutable, no-transform, max-age=31536000",
      "Content-Type": "image/png",
    },
  });
}
