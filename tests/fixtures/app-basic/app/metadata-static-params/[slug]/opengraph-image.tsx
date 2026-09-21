const posts: Record<string, string> = {
  "public-post": "PUBLIC",
  "public post": "PUBLIC ENCODED",
  "unlisted-draft": "UNLISTED_METADATA",
};

export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "public-post" }, { slug: "public post" }];
}

export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(posts[slug] ?? "missing", {
    headers: { "content-type": "text/plain" },
  });
}
