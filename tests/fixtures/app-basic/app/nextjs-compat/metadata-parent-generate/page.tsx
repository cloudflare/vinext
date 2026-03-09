import type { Metadata, ResolvingMetadata } from "next";

// Ported from Next.js: test/e2e/app-dir/metadata/app/dynamic/[slug]/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/app/dynamic/%5Bslug%5D/page.tsx
//
// Demonstrates the `parent` parameter: the page extends the layout's OG images
// instead of replacing them, by reading `(await parent).openGraph?.images`.
export async function generateMetadata(
  _props: Record<string, unknown>,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const parentMeta = await parent;
  const previousImages = parentMeta.openGraph?.images ?? [];
  return {
    title: "parent-generate page",
    openGraph: {
      images: ["/new-image.jpg", ...(previousImages as string[])],
    },
  };
}

export default function Page() {
  return <div id="parent-generate">metadata-parent-generate page</div>;
}
