export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export default async function QueryParallelClientPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <output data-testid="query-parallel-client-slug">{slug}</output>;
}
