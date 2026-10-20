// Next.js production builds leave force-dynamic route handlers out of the
// prerender manifest, so dynamicParams = false only applies in dev.
const posts: Record<string, string> = {
  "public-post": "PUBLIC",
  "unlisted-draft": "UNLISTED_DYNAMIC_ROUTE_HANDLER",
};

export const dynamic = "force-dynamic";
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "public-post" }];
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(`route:${posts[slug] ?? "missing"}`, {
    headers: { "content-type": "text/plain" },
  });
}
