"use cache";

// File-level counterpart of ../../inline/[slug]/page.tsx. Every export of a
// "use cache" module must be async, including generateStaticParams.
export async function generateStaticParams() {
  return [{ slug: "prerendered" }];
}

export default async function FileUseCachePropsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return <h1 data-testid="use-cache-page-props-slug">{(await params).slug}</h1>;
}
