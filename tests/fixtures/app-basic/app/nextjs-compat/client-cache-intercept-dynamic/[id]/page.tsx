export default async function ClientCacheInterceptDynamicTarget({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <div id="client-cache-intercept-dynamic-target">{id}</div>;
}
