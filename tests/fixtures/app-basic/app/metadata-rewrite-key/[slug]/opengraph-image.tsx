// Used by E2E: app-router/isr.spec.ts — the /metadata-rewrite-card/:slug
// config rewrite onto this route shares the ISR entry of the destination's
// own URL, as Next.js keys it, and never that of a double-encoded spelling.
export function generateStaticParams() {
  return [];
}

export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(`card ${slug}`, { headers: { "content-type": "text/plain" } });
}
