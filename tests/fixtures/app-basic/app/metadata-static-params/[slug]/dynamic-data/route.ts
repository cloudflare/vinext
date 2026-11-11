// Next.js production builds leave force-dynamic route handlers out of the
// prerender manifest, so dynamicParams = false only applies in dev.
const posts: Record<string, string> = {
  "public-post": "PUBLIC",
  "unlisted-draft": "DRAFT DYNAMIC DATA",
};

export const dynamic = "force-dynamic";
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "public-post" }];
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(`data:${posts[slug] ?? "missing"}`, {
    headers: { "content-type": "text/plain" },
  });
}
