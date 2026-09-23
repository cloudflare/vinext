// Next.js on-demand ISR via generateStaticParams returning no paths:
// https://nextjs.org/docs/app/api-reference/functions/generate-static-params
export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export default async function QueryOnDemandPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main>
      <output data-testid="query-on-demand-slug">{slug}</output>
      <output data-testid="query-on-demand-id">{crypto.randomUUID()}</output>
    </main>
  );
}
