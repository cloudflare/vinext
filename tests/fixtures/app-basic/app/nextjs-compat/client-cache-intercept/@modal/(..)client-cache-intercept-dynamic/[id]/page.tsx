// generateStaticParams makes this intercepting page static (●), even though
// its target page is dynamic.
export function generateStaticParams() {
  return [];
}

export default async function ClientCacheInterceptStaticModal({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <div id="client-cache-intercept-static-modal">{id}</div>;
}
