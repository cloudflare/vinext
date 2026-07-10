export const dynamic = "force-static";

export function generateStaticParams() {
  return [];
}

export default async function FallbackPrefetchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <h1 data-testid="fallback-prefetch-page">Fallback page: {id}</h1>;
}
