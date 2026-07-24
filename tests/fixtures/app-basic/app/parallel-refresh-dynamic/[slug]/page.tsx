import Link from "next/link";

export default async function ParallelRefreshDynamicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main data-testid="parallel-refresh-dynamic-page">
      <Link href={`/parallel-refresh-dynamic/${slug}/login?source=modal`}>Open dynamic login</Link>
      <p data-testid="parallel-refresh-dynamic-page-token">{Math.random()}</p>
    </main>
  );
}
