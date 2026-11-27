// Used by tests/app-router-metadata-routes.test.ts: a static-segment
// metadata route that must win over [slug]/opengraph-image.tsx.
export default async function Image() {
  return new Response("static custom-font", { headers: { "content-type": "text/plain" } });
}
