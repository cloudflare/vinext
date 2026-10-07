"use cache";

// Bound by ./page.tsx. React's server-reference `.bind()` keeps `$$typeof` and
// `$$id`, so the bound functions are still recognized as cache functions.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `use cache page props ${(await params).slug}` };
}

export default async function BoundUseCachePropsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return <h1 data-testid="use-cache-page-props-slug">{(await params).slug}</h1>;
}
