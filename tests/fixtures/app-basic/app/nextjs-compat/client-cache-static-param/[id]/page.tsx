// A statically generated dynamic route with no loading boundary: its
// automatic prefetch is cheap, so it is re-prefetched after invalidations.
export function generateStaticParams() {
  return [{ id: "1" }];
}

export default async function ClientCacheStaticParamTarget({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <div id="client-cache-static-param-id">{id}</div>;
}
