const posts: Record<string, string> = {
  "public-post": "PUBLIC",
  "public post": "PUBLIC ENCODED",
  "public%20post": "PUBLIC ESCAPED",
  "public%2Fpost": "PUBLIC ESCAPED SLASH",
  "unlisted-draft": "UNLISTED_METADATA",
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

export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(posts[slug] ?? "missing", {
    headers: { "content-type": "text/plain" },
  });
}
