"use cache";

// Re-exported by ./page.tsx. These cache functions are defined outside the
// page file, so page semantics come from the invocation's `$$isPage` marker.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `use cache page props ${(await params).slug}` };
}

export async function generateViewport({ params }: { params: Promise<{ slug: string }> }) {
  await params;
  return { themeColor: "#123456" };
}

export default async function ReexportedUseCachePropsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return <h1 data-testid="use-cache-page-props-slug">{(await params).slug}</h1>;
}
