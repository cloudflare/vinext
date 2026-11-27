// Used by tests/app-router-metadata-routes.test.ts: a dynamic sibling of
// custom-font/opengraph-image.tsx. Next.js matches the static segment first.
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(`dynamic ${slug}`, { headers: { "content-type": "text/plain" } });
}
