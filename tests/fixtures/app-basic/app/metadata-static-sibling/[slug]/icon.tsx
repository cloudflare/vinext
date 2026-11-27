// Used by tests/app-router-metadata-routes.test.ts: listed before its static
// sibling icon1.png, in the order the files are found.
export default async function Icon({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(`icon ${slug}`, { headers: { "content-type": "text/plain" } });
}
