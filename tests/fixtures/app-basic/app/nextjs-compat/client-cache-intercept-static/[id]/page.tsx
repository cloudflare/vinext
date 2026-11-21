export function generateStaticParams() {
  return [];
}

export default async function ClientCacheInterceptStaticTarget({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <div id="client-cache-intercept-static-target">{id}</div>;
}
