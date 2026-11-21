export default async function DynamicParamsFallbackTargetPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <p id="dynamic-params-fallback-target">{`fallback target ${slug}`}</p>;
}
