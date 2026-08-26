export default async function ProbeQueryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  if ("__vinext_cacheability_probe" in resolved) {
    throw new Error("internal cacheability probe query leaked to route code");
  }
  return <p>Probe query is hidden</p>;
}
