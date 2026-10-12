"use cache";

// File-level counterpart of ../../inline/[slug]/page.tsx. Every export of a
// "use cache" module must be async, including generateStaticParams.
export async function generateStaticParams() {
  return [{ slug: "prerendered" }];
}

// Page metadata functions receive the page's props too, so they also leave
// searchParams out of their cache key and serialized arguments.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `use cache page props ${(await params).slug}` };
}

export async function generateViewport({ params }: { params: Promise<{ slug: string }> }) {
  await params;
  return { themeColor: "#123456" };
}

export default async function FileUseCachePropsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return <h1 data-testid="use-cache-page-props-slug">{(await params).slug}</h1>;
}
