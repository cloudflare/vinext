// Mirrors Next.js' route handler half of
// test/e2e/app-dir/nsec-105-opengraph-image-dynamicparams.
const posts: Record<string, string> = {
  "public-post": "PUBLIC",
  "public post": "PUBLIC ENCODED",
  "public%20post": "PUBLIC ESCAPED",
  "public%2Fpost": "PUBLIC ESCAPED SLASH",
  "unlisted-draft": "UNLISTED_ROUTE_HANDLER",
};

export const dynamicParams = false;

export function generateStaticParams() {
  return [
    { slug: "public-post" },
    { slug: "public post" },
    { slug: "public%20post" },
    { slug: "public%2Fpost" },
  ];
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(`route:${posts[slug] ?? "missing"}`, {
    headers: { "content-type": "text/plain" },
  });
}
