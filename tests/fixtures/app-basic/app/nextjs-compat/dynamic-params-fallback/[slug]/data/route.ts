// Used by E2E: nextjs-compat/segment-cache-dynamic-params.spec.ts. next.config
// has a fallback rewrite for this route's unlisted params.
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "listed" }];
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(`listed data ${slug}`, { headers: { "content-type": "text/plain" } });
}
